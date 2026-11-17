// §8 — Snapshot store. Persistent state between scan runs, backed by a single
// SQLite file that the GitHub Actions workflow commits back to the repo. No
// external database to provision.
//
// Uses Node's built-in `node:sqlite` (stable in Node 24), so the store itself
// needs no dependency and no native build in CI.
//
// Four append-only tables:
//   snapshots — what each source said on every successful scan (the diff
//               engine only ever needs the latest row per source)
//   runs      — one row per scan run, with its counts and full report
//   changes   — every NEW / CHANGED / DISCONTINUED event, with before/after
//               values: the dashboard's change feed and per-card timeline
//   captures  — screenshots of the offer as the customer saw it, as files
//               under data/captures/ referenced by path

import { DatabaseSync } from 'node:sqlite';

export class SnapshotStore {
  /** @param {string} path SQLite file path, or ':memory:' for tests. */
  constructor(path = ':memory:', { readOnly = false } = {}) {
    this.db = new DatabaseSync(path, { readOnly });
    if (readOnly) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id      TEXT    NOT NULL,
        scan_timestamp TEXT    NOT NULL,
        region_found   INTEGER NOT NULL,
        raw_offer_text TEXT,
        parsed_offer   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_source ON snapshots(source_id, id);

      CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        counts      TEXT NOT NULL,
        report      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS changes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         INTEGER,
        source_id      TEXT NOT NULL,
        detected_at    TEXT NOT NULL,
        classification TEXT NOT NULL,
        changed_fields TEXT NOT NULL,
        previous_offer TEXT,
        current_offer  TEXT,
        headline       TEXT,
        capture_before TEXT,
        capture_after  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_changes_source ON changes(source_id, id);

      CREATE TABLE IF NOT EXISTS captures (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id      TEXT NOT NULL,
        scan_timestamp TEXT NOT NULL,
        path           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_captures_source ON captures(source_id, id);
    `);
  }

  /**
   * The last stored snapshot for a source, shaped exactly as diffOffer's
   * `previous` argument expects. Returns null when the source has never been
   * scanned — which diffOffer treats as NEW.
   */
  getLatestSnapshot(sourceId) {
    const row = this.db
      .prepare(
        `SELECT scan_timestamp, region_found, raw_offer_text, parsed_offer
           FROM snapshots
          WHERE source_id = ?
          ORDER BY id DESC
          LIMIT 1`
      )
      .get(sourceId);
    if (!row) return null;
    return {
      sourceId,
      scanTimestamp: row.scan_timestamp,
      regionFound: row.region_found === 1,
      rawOfferText: row.raw_offer_text ?? null,
      parsedOffer: row.parsed_offer ? JSON.parse(row.parsed_offer) : null,
    };
  }

  putSnapshot({ sourceId, scanTimestamp, regionFound, rawOfferText, parsedOffer }) {
    this.db
      .prepare(
        `INSERT INTO snapshots (source_id, scan_timestamp, region_found, raw_offer_text, parsed_offer)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        sourceId,
        scanTimestamp ?? new Date().toISOString(),
        regionFound ? 1 : 0,
        rawOfferText ?? null,
        parsedOffer ? JSON.stringify(parsedOffer) : null
      );
  }

  // --- captures ------------------------------------------------------------

  getLatestCapture(sourceId) {
    const row = this.db
      .prepare(
        `SELECT scan_timestamp, path FROM captures WHERE source_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(sourceId);
    return row ? { sourceId, scanTimestamp: row.scan_timestamp, path: row.path } : null;
  }

  putCapture({ sourceId, scanTimestamp, path }) {
    this.db
      .prepare(`INSERT INTO captures (source_id, scan_timestamp, path) VALUES (?, ?, ?)`)
      .run(sourceId, scanTimestamp, path);
  }

  // --- runs & changes ------------------------------------------------------

  putRun({ startedAt, finishedAt, counts, report }) {
    const result = this.db
      .prepare(`INSERT INTO runs (started_at, finished_at, counts, report) VALUES (?, ?, ?, ?)`)
      .run(startedAt, finishedAt, JSON.stringify(counts), JSON.stringify(report));
    return Number(result.lastInsertRowid);
  }

  getLatestRun() {
    const row = this.db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`).get();
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      counts: JSON.parse(row.counts),
      report: JSON.parse(row.report),
    };
  }

  getFirstRunId() {
    return this.db.prepare(`SELECT MIN(id) AS id FROM runs`).get().id ?? null;
  }

  countRuns() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n;
  }

  putChange(change) {
    this.db
      .prepare(
        `INSERT INTO changes (run_id, source_id, detected_at, classification, changed_fields,
                              previous_offer, current_offer, headline, capture_before, capture_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        change.runId ?? null,
        change.sourceId,
        change.detectedAt,
        change.classification,
        JSON.stringify(change.changedFields ?? []),
        change.previousOffer ? JSON.stringify(change.previousOffer) : null,
        change.currentOffer ? JSON.stringify(change.currentOffer) : null,
        change.headline ?? null,
        change.captureBefore ?? null,
        change.captureAfter ?? null
      );
  }

  /** Newest first. Pass a sourceId for one card's timeline. */
  getChanges({ sourceId = null, limit = 200 } = {}) {
    const rows = sourceId
      ? this.db
          .prepare(`SELECT * FROM changes WHERE source_id = ? ORDER BY id DESC LIMIT ?`)
          .all(sourceId, limit)
      : this.db.prepare(`SELECT * FROM changes ORDER BY id DESC LIMIT ?`).all(limit);
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sourceId: row.source_id,
      detectedAt: row.detected_at,
      classification: row.classification,
      changedFields: JSON.parse(row.changed_fields),
      previousOffer: row.previous_offer ? JSON.parse(row.previous_offer) : null,
      currentOffer: row.current_offer ? JSON.parse(row.current_offer) : null,
      headline: row.headline,
      captureBefore: row.capture_before,
      captureAfter: row.capture_after,
    }));
  }

  close() {
    this.db.close();
  }
}
