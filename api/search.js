// Vercel serverless function: /api/search
// Runs a branching review across OpenAlex and optional bring-your-own-key sources.
// BYO keys are used only for this request and are never stored or logged.

const OPENALEX = "https://api.openalex.org";
const OPENALEX_KEY = process.env.OPENALEX_API_KEY || "";
const OPENALEX_MAILTO = process.env.OPENALEX_MAILTO || "";

const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

function openAlexAuth(params) {
  if (OPENALEX_KEY) params.set("api_key", OPENALEX_KEY);
  if (OPENALEX_MAILTO) params.set("mailto", OPENALEX_MAILTO);
  return params;
}

function cleanDoi(doi = "") {
  return String(doi || "")
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "")
    .trim();
}

function cleanIssn(issn = "") {
  return String(issn || "").toUpperCase().replace(/[^0-9X]/g, "");
}

function cleanTitle(title = "") {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstAuthorKey(record) {
  const raw = record.firstAuthor || (record.authors && record.authors[0]) || "";
  return String(raw).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 32);
}

function dedupeKey(record) {
  const doi = cleanDoi(record.doi);
  if (doi) return `doi:${doi}`;
  return `title:${cleanTitle(record.title)}|year:${record.year || ""}|author:${firstAuthorKey(record)}`;
}

function mergeTwo(a, b) {
  const sources = [...new Set([...(a.sources || []), ...(b.sources || [])])];
  const sourceIds = { ...(a.sourceIds || {}), ...(b.sourceIds || {}) };
  const citedBy = { ...(a.citedBy || {}), ...(b.citedBy || {}) };
  const raw = { ...(a.raw || {}), ...(b.raw || {}) };
  const keywords = [...new Set([...(a.keywords || []), ...(b.keywords || [])].filter(Boolean))];
  const concepts = [...new Set([...(a.concepts || []), ...(b.concepts || [])].filter(Boolean))];
  const issns = [...new Set([...(a.issns || []), ...(b.issns || [])].filter(Boolean))];
  const topics = a.topics && a.topics.length ? a.topics : b.topics || [];
  return {
    ...a,
    id: a.id || b.id,
    doi: a.doi || b.doi,
    title: a.title || b.title || "(untitled)",
    year: a.year || b.year || null,
    authors: a.authors && a.authors.length ? a.authors : b.authors || [],
    firstAuthor: a.firstAuthor || b.firstAuthor || null,
    venue: a.venue || b.venue || null,
    issn_l: a.issn_l || b.issn_l || null,
    issns,
    abstract: a.abstract || b.abstract || null,
    type: a.type || b.type || null,
    is_oa: a.is_oa ?? b.is_oa ?? null,
    topics,
    primaryTopic: a.primaryTopic || b.primaryTopic || (topics[0] || null),
    keywords,
    concepts,
    sources,
    sourceIds,
    citedBy,
    raw,
    duplicateKeys: [...new Set([...(a.duplicateKeys || []), ...(b.duplicateKeys || []), dedupeKey(a), dedupeKey(b)])],
    cited_by: Math.max(Number(a.cited_by || 0), Number(b.cited_by || 0)),
  };
}

function mergeList(records) {
  const map = new Map();
  const duplicates = [];
  for (const rec of records) {
    const key = dedupeKey(rec);
    if (!key || key === "title:|year:|author:") continue;
    if (!map.has(key)) {
      map.set(key, { ...rec, dedupeKey: key });
    } else {
      const existing = map.get(key);
      duplicates.push({ key, kept: existing.title, duplicate: rec.title, sources: [existing.sources, rec.sources] });
      map.set(key, mergeTwo(existing, rec));
    }
  }
  return { records: [...map.values()], duplicates };
}

function abstractText(inv) {
  if (!inv || typeof inv !== "object") return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions.push([i, word]);
  }
  if (!positions.length) return null;
  positions.sort((a, b) => a[0] - b[0]);
  const text = positions.map((p) => p[1]).join(" ");
  return text.length > 2000 ? text.slice(0, 2000) + "\u2026" : text;
}

function shapeOpenAlex(w) {
  const src = w.primary_location && w.primary_location.source;
  const authors = (w.authorships || [])
    .map((a) => a.author && a.author.display_name)
    .filter(Boolean);
  const topics = (w.topics || []).map((t) => ({
    name: t.display_name,
    subfield: t.subfield && t.subfield.display_name,
    field: t.field && t.field.display_name,
    domain: t.domain && t.domain.display_name,
    score: t.score,
  }));
  const id = w.id || "";
  return {
    id: `openalex:${id.split("/").pop()}`,
    doi: w.doi || null,
    title: w.title || "(untitled)",
    year: w.publication_year || null,
    authors,
    firstAuthor: authors[0] || null,
    venue: src ? src.display_name : null,
    issn_l: src ? src.issn_l : null,
    issns: src && src.issn ? src.issn : src && src.issn_l ? [src.issn_l] : [],
    cited_by: w.cited_by_count || 0,
    citedBy: { openalex: w.cited_by_count || 0 },
    type: w.type || null,
    is_oa: w.open_access ? w.open_access.is_oa : null,
    topics,
    primaryTopic: topics[0] || null,
    keywords: (w.keywords || []).map((k) => k.display_name || k.keyword).filter(Boolean),
    concepts: (w.concepts || []).filter((c) => c.level <= 2 && c.score >= 0.3).map((c) => c.display_name),
    abstract: abstractText(w.abstract_inverted_index),
    sources: ["openalex"],
    sourceIds: { openalex: id.split("/").pop() },
    raw: {},
  };
}

function breakdown(list) {
  const tally = (arr) => {
    const m = new Map();
    arr.forEach((x) => x && m.set(x, (m.get(x) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };
  const domains = [], fields = [], subfields = [], topics = [], keywords = [];
  list.forEach((w) => {
    if (w.primaryTopic) {
      domains.push(w.primaryTopic.domain);
      fields.push(w.primaryTopic.field);
      subfields.push(w.primaryTopic.subfield);
      topics.push(w.primaryTopic.name);
    }
    (w.keywords || []).forEach((k) => keywords.push(k));
  });
  return {
    domains: tally(domains),
    fields: tally(fields),
    subfields: tally(subfields).slice(0, 12),
    topics: tally(topics).slice(0, 12),
    keywords: tally(keywords).slice(0, 15),
    years: tally(list.map((w) => w.year).filter(Boolean)).sort((a, b) => Number(a.name) - Number(b.name)),
  };
}

function issnFilter(issns) {
  const clean = issns.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 100);
  if (!clean.length) return null;
  return `primary_location.source.issn:${clean.join("|")}`;
}

async function fetchOpenAlexAll(filter, { search, cap = 600 } = {}) {
  const out = [];
  let cursor = "*";
  const select =
    "id,doi,title,publication_year,authorships,primary_location,cited_by_count," +
    "topics,keywords,concepts,abstract_inverted_index,type,open_access";
  while (cursor && out.length < cap) {
    const p = openAlexAuth(new URLSearchParams());
    p.set("filter", filter);
    if (search) p.set("search", search);
    p.set("per_page", "100");
    p.set("cursor", cursor);
    p.set("select", select);
    const r = await fetch(`${OPENALEX}/works?${p.toString()}`);
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`OpenAlex ${r.status}: ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    out.push(...(data.results || []));
    cursor = data.meta && data.meta.next_cursor;
    if (!data.results || data.results.length === 0) break;
  }
  return out.slice(0, cap).map(shapeOpenAlex);
}

async function resolveOpenAlexSeed(seedId) {
  const seedKey = String(seedId || "").startsWith("http")
    ? String(seedId).split("/").pop()
    : String(seedId || "").replace(/^doi:/i, "");
  if (!seedKey) return null;
  if (!seedKey.includes("10.")) return seedKey;
  const p = openAlexAuth(new URLSearchParams());
  const r = await fetch(`${OPENALEX}/works/doi:${encodeURIComponent(seedKey)}?${p.toString()}`);
  if (!r.ok) return null;
  const d = await r.json();
  return (d.id || "").split("/").pop();
}

function scopusTerms(keywords) {
  const terms = String(keywords || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[()]/g, ""));
  if (!terms.length) return "";
  return terms.join(" AND ");
}

function scopusIssnClause(issns) {
  const list = (issns || []).map(cleanIssn).filter(Boolean).slice(0, 60);
  if (!list.length) return "";
  return "(" + list.map((i) => `ISSN(${i})`).join(" OR ") + ")";
}

function scopusYearClause(yearFrom, yearTo) {
  const parts = [];
  if (yearFrom) parts.push(`PUBYEAR > ${Number(yearFrom) - 1}`);
  if (yearTo) parts.push(`PUBYEAR < ${Number(yearTo) + 1}`);
  return parts.length ? `(${parts.join(" AND ")})` : "";
}

function joinQuery(parts) {
  return parts.filter(Boolean).join(" AND ");
}

async function fetchScopus(query, { apiKey, instToken, cap = 500 } = {}) {
  if (!apiKey) throw new Error("Scopus selected but no Scopus API key was provided.");
  const out = [];
  let start = 0;
  const count = 25; // COMPLETE view max is 25
  while (out.length < cap) {
    const p = new URLSearchParams();
    p.set("query", query);
    p.set("start", String(start));
    p.set("count", String(count));
    p.set("view", "COMPLETE");
    const headers = {
      Accept: "application/json",
      "X-ELS-APIKey": apiKey,
    };
    if (instToken) headers["X-ELS-Insttoken"] = instToken;
    const r = await fetch(`https://api.elsevier.com/content/search/scopus?${p.toString()}`, { headers });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok) throw new Error(`Scopus ${r.status}: ${(data && data["service-error"] && data["service-error"].status && data["service-error"].status.statusText) || text.slice(0, 200)}`);
    const entries = data && data["search-results"] && data["search-results"].entry ? data["search-results"].entry : [];
    out.push(...entries.map(shapeScopus));
    if (entries.length < count) break;
    start += count;
    if (start >= 5000) break;
  }
  return out.slice(0, cap);
}

function listify(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function shapeScopus(e) {
  const idRaw = e.eid || e["dc:identifier"] || e["prism:url"] || cleanDoi(e["prism:doi"]);
  const doi = e["prism:doi"] || null;
  const coverDate = e["prism:coverDate"] || "";
  const year = coverDate ? Number(String(coverDate).slice(0, 4)) : null;
  const authorObj = listify(e.author);
  const authors = authorObj.length
    ? authorObj.map((a) => a.authname || a["ce:indexed-name"] || a["preferred-name"]?.surname || a.surname).filter(Boolean)
    : e["dc:creator"] ? [e["dc:creator"]] : [];
  const cited = Number(e["citedby-count"] || 0);
  const keywords = [];
  if (e.authkeywords) keywords.push(...String(e.authkeywords).split("|").map((s) => s.trim()).filter(Boolean));
  return {
    id: `scopus:${idRaw}`,
    doi,
    title: e["dc:title"] || "(untitled)",
    year,
    authors,
    firstAuthor: authors[0] || e["dc:creator"] || null,
    venue: e["prism:publicationName"] || null,
    issn_l: e["prism:issn"] || null,
    issns: e["prism:issn"] ? [e["prism:issn"]] : [],
    cited_by: cited,
    citedBy: { scopus: cited },
    type: e.subtypeDescription || e.subtype || null,
    is_oa: e.openaccess === "1" ? true : null,
    topics: [],
    primaryTopic: null,
    keywords,
    concepts: [],
    abstract: e["dc:description"] || null,
    sources: ["scopus"],
    sourceIds: { scopus: String(idRaw || "") },
    raw: {},
  };
}

function wosKeywordQuery(keywords, issns, yearFrom, yearTo) {
  const terms = String(keywords || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const topic = terms.length ? `TS=(${terms.join(" AND ")})` : "";
  const issn = (issns || []).map((i) => String(i).trim()).filter(Boolean).slice(0, 50);
  const issnPart = issn.length ? `IS=(${issn.join(" OR ")})` : "";
  const yearPart = yearFrom && yearTo ? `PY=(${yearFrom}-${yearTo})` : yearFrom ? `PY=(${yearFrom}-${new Date().getFullYear()})` : "";
  return joinQuery([topic, issnPart, yearPart]);
}

async function fetchWos(query, { apiKey, baseUrl, cap = 500 } = {}) {
  if (!apiKey) throw new Error("Web of Science selected but no WoS API key was provided.");
  const endpoint = (baseUrl || "https://api.clarivate.com/apis/wos-starter/v1/documents").trim();
  const out = [];
  let page = 1;
  const limit = 50;
  while (out.length < cap) {
    const p = new URLSearchParams();
    p.set("q", query);
    p.set("limit", String(limit));
    p.set("page", String(page));
    const r = await fetch(`${endpoint}?${p.toString()}`, {
      headers: {
        Accept: "application/json",
        "X-ApiKey": apiKey,
      },
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok) throw new Error(`Web of Science ${r.status}: ${text.slice(0, 200)}`);
    const hits = (data && (data.hits || data.documents || data.Records || data.records || data.data)) || [];
    const arr = Array.isArray(hits) ? hits : hits.records || hits.items || [];
    out.push(...arr.map(shapeWos));
    if (!arr.length || arr.length < limit) break;
    page += 1;
  }
  return out.slice(0, cap);
}

function getPath(o, paths) {
  for (const path of paths) {
    let cur = o;
    for (const key of path.split(".")) cur = cur && cur[key];
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return null;
}

function shapeWos(w) {
  const doi = getPath(w, ["identifiers.doi", "doi", "DOI", "dynamic_data.cluster_related.identifiers.identifier.0.value"]);
  const title = getPath(w, ["title", "Title", "static_data.summary.titles.title.0.content", "names.title", "document.title"]);
  const year = Number(getPath(w, ["source.publishYear", "source.publishedYear", "year", "publicationYear", "static_data.summary.pub_info.pubyear"])) || null;
  const venue = getPath(w, ["source.sourceTitle", "source.title", "journal", "source", "static_data.summary.titles.title.1.content"]);
  const uid = getPath(w, ["uid", "UT", "id", "UID"]) || doi || title;
  const cited = Number(getPath(w, ["citations.timesCited", "timesCited", "tc", "static_data.summary.tc_list.silo_tc.0.local_count"]) || 0);
  const abstract = getPath(w, ["abstract", "abstractText", "static_data.fullrecord_metadata.abstracts.abstract.abstract_text.p", "document.abstract"]);
  let authors = getPath(w, ["names.authors", "authors", "static_data.summary.names.name"]);
  if (Array.isArray(authors)) {
    authors = authors.map((a) => a.displayName || a.full_name || a.name || a.content || a).filter(Boolean);
  } else if (typeof authors === "string") {
    authors = authors.split(";").map((s) => s.trim()).filter(Boolean);
  } else {
    authors = [];
  }
  return {
    id: `wos:${uid}`,
    doi,
    title: title || "(untitled)",
    year,
    authors,
    firstAuthor: authors[0] || null,
    venue: venue || null,
    issn_l: getPath(w, ["source.issn", "issn", "ISSN"]) || null,
    issns: [getPath(w, ["source.issn", "issn", "ISSN"] )].filter(Boolean),
    cited_by: cited,
    citedBy: { wos: cited },
    type: getPath(w, ["documentType", "doctype", "type"]) || null,
    is_oa: null,
    topics: [],
    primaryTopic: null,
    keywords: [],
    concepts: [],
    abstract: Array.isArray(abstract) ? abstract.join(" ") : abstract,
    sources: ["wos"],
    sourceIds: { wos: String(uid || "") },
    raw: {},
  };
}

function normalizeManual(r, idx) {
  return {
    id: `upload:${r.id || idx}`,
    doi: r.doi || null,
    title: r.title || "(untitled)",
    year: r.year ? Number(r.year) : null,
    authors: Array.isArray(r.authors) ? r.authors : String(r.authors || "").split(/;|,/).map((s) => s.trim()).filter(Boolean),
    firstAuthor: r.firstAuthor || null,
    venue: r.venue || null,
    issn_l: r.issn || r.issn_l || null,
    issns: [r.issn || r.issn_l].filter(Boolean),
    cited_by: Number(r.cited_by || 0),
    citedBy: { upload: Number(r.cited_by || 0) },
    type: r.type || null,
    is_oa: null,
    topics: [],
    primaryTopic: null,
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    concepts: [],
    abstract: r.abstract || null,
    sources: [r.source || "upload"],
    sourceIds: { upload: String(r.id || idx) },
    raw: {},
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many searches in a short window. Wait a minute and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { res.status(400).json({ error: "Invalid JSON body." }); return; }
  }

  const {
    seedId,
    seedDoi,
    keywords,
    issns,
    yearFrom,
    yearTo,
    runDepth = true,
    runBreadth = true,
    sources = { openalex: true },
    wos = {},
    scopus = {},
    manualRecords = [],
    manualBranch = "breadth",
    dedupe = true,
  } = body || {};

  const jf = issnFilter(Array.isArray(issns) ? issns : []);
  if (!jf && sources.openalex) {
    res.status(400).json({ error: "Add at least one journal ISSN to filter on." });
    return;
  }

  let yearClause = "";
  if (yearFrom && yearTo) yearClause = `,publication_year:${yearFrom}-${yearTo}`;
  else if (yearFrom) yearClause = `,publication_year:>${Number(yearFrom) - 1}`;
  else if (yearTo) yearClause = `,publication_year:<${Number(yearTo) + 1}`;

  const warnings = [];
  const sourceCounts = {};
  const depthAll = [];
  const breadthAll = [];

  try {
    if (sources.openalex) {
      const depthSeedId = runDepth ? await resolveOpenAlexSeed(seedId || seedDoi) : null;
      const [depth, breadth] = await Promise.all([
        runDepth && depthSeedId ? fetchOpenAlexAll(`cites:${depthSeedId},${jf}${yearClause}`) : Promise.resolve([]),
        runBreadth && keywords && keywords.trim() ? fetchOpenAlexAll(`${jf}${yearClause}`, { search: keywords.trim() }) : Promise.resolve([]),
      ]);
      depthAll.push(...depth);
      breadthAll.push(...breadth);
      sourceCounts.openalex = { depth: depth.length, breadth: breadth.length };
    }

    if (sources.scopus) {
      const jClause = scopusIssnClause(issns || []);
      const yClause = scopusYearClause(yearFrom, yearTo);
      const defaultDepth = seedDoi ? joinQuery([`REFDOI(${cleanDoi(seedDoi)})`, jClause, yClause]) : "";
      const defaultBreadth = joinQuery([`TITLE-ABS-KEY(${scopusTerms(keywords)})`, jClause, yClause]);
      const depthQuery = (scopus.depthQuery || defaultDepth || "").trim();
      const breadthQuery = (scopus.breadthQuery || defaultBreadth || "").trim();
      const [depth, breadth] = await Promise.all([
        runDepth && depthQuery ? fetchScopus(depthQuery, scopus) : Promise.resolve([]),
        runBreadth && breadthQuery ? fetchScopus(breadthQuery, scopus) : Promise.resolve([]),
      ]);
      depthAll.push(...depth);
      breadthAll.push(...breadth);
      sourceCounts.scopus = { depth: depth.length, breadth: breadth.length };
    }

    if (sources.wos) {
      const defaultBreadth = wosKeywordQuery(keywords, issns || [], yearFrom, yearTo);
      const depthQuery = (wos.depthQuery || "").trim();
      const breadthQuery = (wos.breadthQuery || defaultBreadth || "").trim();
      if (runDepth && !depthQuery) {
        warnings.push("Web of Science depth search was skipped. Paste a WoS cited-reference/citing-items query in the WoS depth-query box, or upload WoS depth results manually.");
      }
      const [depth, breadth] = await Promise.all([
        runDepth && depthQuery ? fetchWos(depthQuery, wos) : Promise.resolve([]),
        runBreadth && breadthQuery ? fetchWos(breadthQuery, wos) : Promise.resolve([]),
      ]);
      depthAll.push(...depth);
      breadthAll.push(...breadth);
      sourceCounts.wos = { depth: depth.length, breadth: breadth.length };
    }

    if (Array.isArray(manualRecords) && manualRecords.length) {
      const manual = manualRecords.map(normalizeManual);
      if (manualBranch === "depth" || manualBranch === "both") depthAll.push(...manual);
      if (manualBranch === "breadth" || manualBranch === "both") breadthAll.push(...manual);
      sourceCounts.upload = { depth: manualBranch === "breadth" ? 0 : manual.length, breadth: manualBranch === "depth" ? 0 : manual.length };
    }

    const depthMerged = dedupe ? mergeList(depthAll).records : depthAll;
    const breadthMerged = dedupe ? mergeList(breadthAll).records : breadthAll;
    const depthKeys = new Map(depthMerged.map((w) => [dedupeKey(w), w]));
    const breadthKeys = new Map(breadthMerged.map((w) => [dedupeKey(w), w]));
    const overlapKeys = [...depthKeys.keys()].filter((k) => breadthKeys.has(k));

    const overlap = overlapKeys.map((k) => mergeTwo(depthKeys.get(k), breadthKeys.get(k)));
    const overlapSet = new Set(overlapKeys);
    const depthOnly = depthMerged.filter((w) => !overlapSet.has(dedupeKey(w)));
    const breadthOnly = breadthMerged.filter((w) => !overlapSet.has(dedupeKey(w)));
    const allMerged = dedupe ? mergeList([...depthOnly, ...overlap, ...breadthOnly]).records : [...depthOnly, ...overlap, ...breadthOnly];
    const dupInfo = dedupe ? mergeList([...depthAll, ...breadthAll]).duplicates : [];

    res.status(200).json({
      counts: {
        depth: depthMerged.length,
        breadth: breadthMerged.length,
        overlap: overlap.length,
        depthOnly: depthOnly.length,
        breadthOnly: breadthOnly.length,
        total: allMerged.length,
        mergedBeforeDedupe: depthAll.length + breadthAll.length,
        mergedAfterDedupe: allMerged.length,
        duplicatesRemoved: Math.max(0, depthAll.length + breadthAll.length - allMerged.length),
      },
      sourceCounts,
      warnings,
      duplicates: dupInfo.slice(0, 100),
      breakdowns: {
        overlap: breakdown(overlap),
        depthOnly: breakdown(depthOnly),
        breadthOnly: breakdown(breadthOnly),
        all: breakdown(allMerged),
      },
      overlap,
      depthOnly,
      breadthOnly,
      allMerged,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err), warnings });
  }
}
