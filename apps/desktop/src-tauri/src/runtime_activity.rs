use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionRecord {
    pub id: String,
    pub agent_name: String,
    pub source: String,
    pub workspace_path: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub source_updated_at: Option<String>,
    pub status: String,
    pub risk_level: String,
    pub summary: String,
    pub duration_ms: Option<i64>,
    pub total_events: i64,
    pub security_events: i64,
    pub findings_count: i64,
    pub model_calls: i64,
    pub tool_calls: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub avg_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEventRecord {
    pub id: i64,
    pub session_id: String,
    pub event_type: String,
    pub event_time: String,
    pub severity: String,
    pub title: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeToolStatRecord {
    pub tool_name: String,
    pub total_calls: i64,
    pub success_calls: i64,
    pub failure_calls: i64,
    pub avg_latency_ms: f64,
    pub max_latency_ms: f64,
    pub last_called_at: String,
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSecurityAlertRecord {
    pub id: i64,
    pub session_id: String,
    pub source: String,
    pub workspace_path: String,
    pub event_time: String,
    pub severity: String,
    pub title: String,
    pub alert_type: String,
    pub resource: String,
    pub action: String,
    pub blocked: bool,
    pub reason: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeSessionInput {
    pub id: String,
    pub agent_name: String,
    pub source: String,
    pub workspace_path: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub risk_level: String,
    pub summary: String,
    pub duration_ms: Option<i64>,
    pub source_updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeEventInput {
    pub session_id: String,
    pub event_type: String,
    pub event_time: String,
    pub severity: String,
    pub title: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeTelemetryBatchInput {
    pub session: RuntimeSessionInput,
    pub events: Vec<RuntimeEventInput>,
}

pub fn init_db(db_path: &Path) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS runtime_sessions (
              id TEXT PRIMARY KEY,
              agent_name TEXT NOT NULL,
              source TEXT NOT NULL,
              workspace_path TEXT NOT NULL,
              started_at TEXT NOT NULL,
              ended_at TEXT,
              status TEXT NOT NULL,
              risk_level TEXT NOT NULL,
              summary TEXT NOT NULL,
              duration_ms INTEGER,
              source_updated_at TEXT,
              total_events INTEGER NOT NULL DEFAULT 0,
              security_events INTEGER NOT NULL DEFAULT 0,
              findings_count INTEGER NOT NULL DEFAULT 0,
              model_calls INTEGER NOT NULL DEFAULT 0,
              tool_calls INTEGER NOT NULL DEFAULT 0,
              total_input_tokens INTEGER NOT NULL DEFAULT 0,
              total_output_tokens INTEGER NOT NULL DEFAULT 0,
              total_cost_usd REAL NOT NULL DEFAULT 0,
              avg_latency_ms REAL NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS runtime_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              event_time TEXT NOT NULL,
              severity TEXT NOT NULL,
              title TEXT NOT NULL,
              details_json TEXT NOT NULL,
              FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
            );
            "#,
        )
        .map_err(|error| error.to_string())?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "model_calls",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "tool_calls",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "total_input_tokens",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "total_output_tokens",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "total_cost_usd",
        "REAL NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "runtime_sessions",
        "avg_latency_ms",
        "REAL NOT NULL DEFAULT 0",
    )?;
    ensure_column(&connection, "runtime_sessions", "source_updated_at", "TEXT")?;
    connection
        .execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_runtime_events_session_time_id
            ON runtime_events(session_id, event_time DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_runtime_events_event_type_session_time
            ON runtime_events(event_type, session_id, event_time DESC);

            CREATE INDEX IF NOT EXISTS idx_runtime_sessions_source
            ON runtime_sessions(source);
            "#,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn cleanup_duplicate_codex_sessions(db_path: &Path) -> Result<(usize, usize), String> {
    init_db(db_path)?;
    let mut connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let deleted_events = tx
        .execute(
            "DELETE FROM runtime_events
             WHERE session_id IN (
               SELECT id
               FROM runtime_sessions
               WHERE source = 'codex' AND id LIKE 'codex-codex-%'
             )",
            [],
        )
        .map_err(|error| error.to_string())?;

    let deleted_sessions = tx
        .execute(
            "DELETE FROM runtime_sessions
             WHERE source = 'codex' AND id LIKE 'codex-codex-%'",
            [],
        )
        .map_err(|error| error.to_string())?;

    tx.commit().map_err(|error| error.to_string())?;
    Ok((deleted_sessions, deleted_events))
}

pub fn list_sessions(db_path: &Path, limit: usize) -> Result<Vec<RuntimeSessionRecord>, String> {
    init_db(db_path)?;
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, agent_name, source, workspace_path, started_at, ended_at, source_updated_at, status,
                    risk_level, summary, duration_ms, total_events, security_events, findings_count,
                    model_calls, tool_calls, total_input_tokens, total_output_tokens, total_cost_usd, avg_latency_ms
             FROM runtime_sessions
             WHERE source NOT IN ('full_scan', 'repository_scan', 'agentguard-desktop')
             ORDER BY COALESCE(source_updated_at, ended_at, started_at) DESC, started_at DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit as i64], |row| {
            Ok(RuntimeSessionRecord {
                id: row.get(0)?,
                agent_name: row.get(1)?,
                source: row.get(2)?,
                workspace_path: row.get(3)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
                source_updated_at: row.get(6)?,
                status: row.get(7)?,
                risk_level: row.get(8)?,
                summary: row.get(9)?,
                duration_ms: row.get(10)?,
                total_events: row.get(11)?,
                security_events: row.get(12)?,
                findings_count: row.get(13)?,
                model_calls: row.get(14)?,
                tool_calls: row.get(15)?,
                total_input_tokens: row.get(16)?,
                total_output_tokens: row.get(17)?,
                total_cost_usd: row.get(18)?,
                avg_latency_ms: row.get(19)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_events(db_path: &Path, session_id: &str) -> Result<Vec<RuntimeEventRecord>, String> {
    init_db(db_path)?;
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, event_type, event_time, severity, title, details_json
             FROM runtime_events
             WHERE session_id = ?1
             ORDER BY event_time DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![session_id], |row| {
            Ok(RuntimeEventRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_type: row.get(2)?,
                event_time: row.get(3)?,
                severity: row.get(4)?,
                title: row.get(5)?,
                details_json: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_tool_stats(db_path: &Path, limit: usize) -> Result<Vec<RuntimeToolStatRecord>, String> {
    init_db(db_path)?;
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT
                COALESCE(json_extract(re.details_json, '$.tool_name'), 'unknown') AS tool_name,
                COUNT(*) AS total_calls,
                SUM(CASE
                      WHEN COALESCE(json_extract(re.details_json, '$.status'), 'completed') IN ('completed', 'success', 'ok') THEN 1
                      ELSE 0
                    END) AS success_calls,
                SUM(CASE
                      WHEN COALESCE(json_extract(re.details_json, '$.status'), 'completed') IN ('completed', 'success', 'ok') THEN 0
                      ELSE 1
                    END) AS failure_calls,
                AVG(COALESCE(CAST(json_extract(re.details_json, '$.latency_ms') AS REAL), 0)) AS avg_latency_ms,
                MAX(COALESCE(CAST(json_extract(re.details_json, '$.latency_ms') AS REAL), 0)) AS max_latency_ms,
                MAX(re.event_time) AS last_called_at,
                COUNT(DISTINCT re.session_id) AS session_count
             FROM runtime_events re
             JOIN runtime_sessions rs ON rs.id = re.session_id
             WHERE rs.source NOT IN ('full_scan', 'repository_scan', 'agentguard-desktop')
               AND re.event_type = 'tool_finished'
             GROUP BY tool_name
             ORDER BY total_calls DESC, last_called_at DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit as i64], |row| {
            Ok(RuntimeToolStatRecord {
                tool_name: row.get(0)?,
                total_calls: row.get(1)?,
                success_calls: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                failure_calls: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                avg_latency_ms: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                max_latency_ms: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                last_called_at: row.get(6)?,
                session_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_security_alerts(
    db_path: &Path,
    limit: usize,
) -> Result<Vec<RuntimeSecurityAlertRecord>, String> {
    init_db(db_path)?;
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT
                re.id,
                re.session_id,
                rs.source,
                rs.workspace_path,
                re.event_time,
                re.severity,
                re.title,
                COALESCE(
                  json_extract(re.details_json, '$.alert_type'),
                  json_extract(re.details_json, '$.attributes.policy'),
                  json_extract(re.details_json, '$.attributes.event.name'),
                  re.event_type
                ) AS alert_type,
                COALESCE(
                  json_extract(re.details_json, '$.resource'),
                  json_extract(re.details_json, '$.attributes.resource'),
                  json_extract(re.details_json, '$.attributes.tool_name'),
                  ''
                ) AS resource,
                COALESCE(
                  json_extract(re.details_json, '$.action'),
                  json_extract(re.details_json, '$.attributes.action'),
                  ''
                ) AS action,
                COALESCE(CAST(json_extract(re.details_json, '$.blocked') AS INTEGER), 0) AS blocked,
                COALESCE(
                  json_extract(re.details_json, '$.reason'),
                  json_extract(re.details_json, '$.attributes.reason'),
                  ''
                ) AS reason,
                re.details_json
             FROM runtime_events re
             JOIN runtime_sessions rs ON rs.id = re.session_id
             WHERE rs.source NOT IN ('full_scan', 'repository_scan', 'agentguard-desktop')
               AND (re.event_type = 'security_alert' OR re.severity = 'critical')
             ORDER BY re.event_time DESC, re.id DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit as i64], |row| {
            Ok(RuntimeSecurityAlertRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                source: row.get(2)?,
                workspace_path: row.get(3)?,
                event_time: row.get(4)?,
                severity: row.get(5)?,
                title: row.get(6)?,
                alert_type: row
                    .get::<_, Option<String>>(7)?
                    .unwrap_or_else(|| "security_alert".to_string()),
                resource: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                action: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                blocked: row.get::<_, Option<i64>>(10)?.unwrap_or(0) > 0,
                reason: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                details_json: row.get::<_, String>(12)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn ingest_batch(db_path: &Path, payload: RuntimeTelemetryBatchInput) -> Result<(), String> {
    init_db(db_path)?;
    let mut connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    upsert_session_tx(&tx, &payload.session)?;
    for event in &payload.events {
        insert_event_tx(&tx, event)?;
    }
    refresh_session_counters_tx(&tx, &payload.session.id)?;

    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn upsert_session(db_path: &Path, session: RuntimeSessionInput) -> Result<(), String> {
    init_db(db_path)?;
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    upsert_session_tx(&connection, &session)
}

pub fn append_event(db_path: &Path, event: RuntimeEventInput) -> Result<(), String> {
    init_db(db_path)?;
    let mut connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    insert_event_tx(&tx, &event)?;
    refresh_session_counters_tx(&tx, &event.session_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_session_tx(connection: &Connection, session: &RuntimeSessionInput) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO runtime_sessions (
                id, agent_name, source, workspace_path, started_at, ended_at, status,
                risk_level, summary, duration_ms, source_updated_at, total_events, security_events, findings_count,
                model_calls, tool_calls, total_input_tokens, total_output_tokens, total_cost_usd, avg_latency_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, 0, 0, 0, 0, 0, 0)
             ON CONFLICT(id) DO UPDATE SET
                agent_name = excluded.agent_name,
                source = excluded.source,
                workspace_path = excluded.workspace_path,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                status = excluded.status,
                risk_level = excluded.risk_level,
                summary = excluded.summary,
                duration_ms = excluded.duration_ms,
                source_updated_at = excluded.source_updated_at",
            params![
                session.id,
                session.agent_name,
                session.source,
                session.workspace_path,
                session.started_at,
                session.ended_at,
                session.status,
                session.risk_level,
                session.summary,
                session.duration_ms,
                session.source_updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_event_tx(connection: &Connection, event: &RuntimeEventInput) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO runtime_events (session_id, event_type, event_time, severity, title, details_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.session_id,
                event.event_type,
                event.event_time,
                event.severity,
                event.title,
                event.details_json
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn refresh_session_counters_tx(connection: &Connection, session_id: &str) -> Result<(), String> {
    let (
        total_events,
        security_events,
        findings_count,
        risk_level,
        model_calls,
        tool_calls,
        total_input_tokens,
        total_output_tokens,
        total_cost_usd,
        avg_latency_ms,
    ): (i64, i64, i64, String, i64, i64, i64, i64, f64, f64) =
        connection
            .query_row(
                "SELECT
                    COUNT(*) AS total_events,
                    SUM(CASE WHEN event_type = 'security_alert' OR severity = 'critical' THEN 1 ELSE 0 END) AS security_events,
                    SUM(CASE WHEN event_type = 'security_alert' THEN 1 ELSE 0 END) AS findings_count,
                    CASE
                      WHEN SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) > 0 THEN 'high'
                      WHEN SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) > 0 THEN 'medium'
                      ELSE 'low'
                    END AS risk_level,
                    SUM(CASE WHEN event_type = 'model_response' THEN 1 ELSE 0 END) AS model_calls,
                    SUM(CASE WHEN event_type = 'tool_finished' THEN 1 ELSE 0 END) AS tool_calls,
                    SUM(CASE WHEN event_type = 'model_response' THEN COALESCE(CAST(json_extract(details_json, '$.input_tokens') AS INTEGER), 0) ELSE 0 END) AS total_input_tokens,
                    SUM(CASE WHEN event_type = 'model_response' THEN COALESCE(CAST(json_extract(details_json, '$.output_tokens') AS INTEGER), 0) ELSE 0 END) AS total_output_tokens,
                    SUM(CASE WHEN event_type = 'model_response' THEN COALESCE(CAST(json_extract(details_json, '$.estimated_cost_usd') AS REAL), 0) ELSE 0 END) AS total_cost_usd,
                    AVG(CASE WHEN event_type IN ('model_response', 'tool_finished') THEN CAST(json_extract(details_json, '$.latency_ms') AS REAL) END) AS avg_latency_ms
                 FROM runtime_events
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        row.get(3)?,
                        row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                        row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                        row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                    ))
                },
            )
            .map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE runtime_sessions
             SET total_events = ?2,
                 security_events = ?3,
                 findings_count = ?4,
                 risk_level = CASE WHEN risk_level IN ('critical', 'high') THEN risk_level ELSE ?5 END,
                 model_calls = ?6,
                 tool_calls = ?7,
                 total_input_tokens = ?8,
                 total_output_tokens = ?9,
                 total_cost_usd = ?10,
                 avg_latency_ms = ?11
             WHERE id = ?1",
            params![
                session_id,
                total_events,
                security_events,
                findings_count,
                risk_level,
                model_calls,
                tool_calls,
                total_input_tokens,
                total_output_tokens,
                total_cost_usd,
                avg_latency_ms
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    match connection.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(error) => {
            let message = error.to_string();
            if message.contains("duplicate column name") {
                Ok(())
            } else {
                Err(message)
            }
        }
    }
}
