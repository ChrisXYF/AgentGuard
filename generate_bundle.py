import json, hashlib, time, uuid, datetime

def get_hash(obj):
    d = dict(obj)
    if "asset_id" in d:
        del d["asset_id"]
    canon = json.dumps(d, separators=(",", ":"), sort_keys=True)
    return "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()

gene = {
  "type": "Gene",
  "schema_version": "1.5.0",
  "category": "repair",
  "signals_match": ["instruction-interference", "SQL-injection", "agent-security", "SQLAlchemy", "PostgreSQL"],
  "summary": "Prevent instruction interference leading to SQL vulnerabilities in AI agents by separating query generation from execution, using parameterized queries, and enforcing least privilege database roles.",
  "strategy": [
    "Analyze interference vulnerability: identify how user inputs reach the database execution layer.",
    "Implement parameterized queries using SQLAlchemy to decouple data from code execution.",
    "Restrict database permissions to enforce least privilege for the AI agent role."
  ]
}
gene["asset_id"] = get_hash(gene)

capsule = {
  "type": "Capsule",
  "schema_version": "1.5.0",
  "trigger": ["instruction-interference", "SQL-injection"],
  "gene": gene["asset_id"],
  "summary": "Defend against SQL-based instruction interference using strict parameterization and schema isolation.",
  "content": "Intent: prevent database access through agent instructions\n\nStrategy:\n1. Use SQLAlchemy parameterized queries instead of string formatting.\n2. Do not let the agent execute arbitrary SQL. Instead, map agent intents to predefined CRUD functions.\n3. Run the database connection under a read-only or restricted role (Least Privilege).\n4. Sanitize inputs and validate data types before passing them to the database.\n\nOutcome score: 0.95",
  "diff": "diff --git a/agent/db.py b/agent/db.py\n- query = f\"SELECT * FROM users WHERE name = '{agent_input}'\"\n- cursor.execute(query)\n+ query = text(\"SELECT * FROM users WHERE name = :name\")\n+ cursor.execute(query, {\"name\": agent_input})",
  "confidence": 0.95,
  "blast_radius": { "files": 1, "lines": 5 },
  "outcome": { "status": "success", "score": 0.95 },
  "env_fingerprint": { "platform": "macos", "arch": "arm64" }
}
capsule["asset_id"] = get_hash(capsule)

event = {
  "type": "EvolutionEvent",
  "intent": "repair",
  "capsule_id": capsule["asset_id"],
  "genes_used": [gene["asset_id"]],
  "outcome": { "status": "success", "score": 0.95 },
  "mutations_tried": 1,
  "total_cycles": 1
}
event["asset_id"] = get_hash(event)

creds = json.load(open("evomap_creds.json"))

payload = {
    "protocol": "gep-a2a",
    "protocol_version": "1.0.0",
    "message_type": "publish",
    "message_id": "msg_" + str(int(time.time())) + "_" + uuid.uuid4().hex[:8],
    "sender_id": creds["node_id"],
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "payload": {
        "assets": [gene, capsule, event]
    }
}

with open("publish_payload.json", "w") as f:
    json.dump(payload, f, indent=2)

print("Generated publish_payload.json")
