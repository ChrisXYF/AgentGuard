# Activity Monitor OTLP Bridge

活动监控现在只保留标准 OTLP/HTTP JSON 接入。

本地 bridge 默认监听：

- `POST http://127.0.0.1:46357/v1/logs`
- `POST http://127.0.0.1:46357/v1/traces`
- `POST http://127.0.0.1:46357/v1/metrics`
- `GET http://127.0.0.1:46357/health`

## 设计原则

- `service.name` / `scope.name` 用来识别来源，例如 `codex`、`claude`、`openclaw`
- `session_id` / `run_id` / `trace_id` 用来聚合成一个活动会话
- `tool_name`、`input_token_count`、`output_token_count`、`cost_usd`、`duration_ms` 这些字段会自动映射到活动监控摘要

## 最小 OTLP Logs 示例

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "codex-cli" } },
          { "key": "workspace.path", "value": { "stringValue": "/Users/example/project" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "codex_runtime" },
          "logRecords": [
            {
              "timeUnixNano": "1773580000000000000",
              "severityText": "INFO",
              "body": { "stringValue": "Tool call completed" },
              "attributes": [
                { "key": "session_id", "value": { "stringValue": "run-123" } },
                { "key": "tool_name", "value": { "stringValue": "exec_command" } },
                { "key": "status", "value": { "stringValue": "completed" } },
                { "key": "duration_ms", "value": { "intValue": "842" } }
              ]
            },
            {
              "timeUnixNano": "1773580001000000000",
              "severityText": "INFO",
              "body": { "stringValue": "Model response received" },
              "attributes": [
                { "key": "session_id", "value": { "stringValue": "run-123" } },
                { "key": "model", "value": { "stringValue": "gpt-5.4" } },
                { "key": "input_token_count", "value": { "intValue": "3210" } },
                { "key": "output_token_count", "value": { "intValue": "842" } },
                { "key": "cost_usd", "value": { "doubleValue": 0.0834 } },
                { "key": "duration_ms", "value": { "intValue": "4230" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## 最小 OTLP Traces 示例

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "claude-code" } },
          { "key": "workspace.path", "value": { "stringValue": "/Users/example/project" } }
        ]
      },
      "scopeSpans": [
        {
          "scope": { "name": "claude_runtime" },
          "spans": [
            {
              "traceId": "aabbccddeeff00112233445566778899",
              "spanId": "0011223344556677",
              "name": "tool.exec",
              "startTimeUnixNano": "1773580000000000000",
              "endTimeUnixNano": "1773580000820000000",
              "attributes": [
                { "key": "session_id", "value": { "stringValue": "claude-run-456" } },
                { "key": "tool_name", "value": { "stringValue": "Bash" } }
              ],
              "status": { "code": 0 }
            },
            {
              "traceId": "aabbccddeeff00112233445566778899",
              "spanId": "8899aabbccddeeff",
              "name": "model.inference",
              "startTimeUnixNano": "1773580001000000000",
              "endTimeUnixNano": "1773580005230000000",
              "attributes": [
                { "key": "session_id", "value": { "stringValue": "claude-run-456" } },
                { "key": "model", "value": { "stringValue": "claude-3-7-sonnet" } },
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "2800" } },
                { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "620" } },
                { "key": "cost_usd", "value": { "doubleValue": 0.0412 } }
              ],
              "status": { "code": 0 }
            }
          ]
        }
      ]
    }
  ]
}
```

## 字段映射

- `tool_name` -> `tool_finished`
- `model` + token 字段 -> `model_response`
- `severity = ERROR/FATAL` 或策略字段 -> `security_alert`
- 其他 logs/spans -> 普通 runtime 事件

## 建议

- Codex / Claude / OpenClaw 如果能直接发 OTLP，就优先发标准 OTLP
- 如果上游只能产出自定义 JSON，建议先在上游转换成 OTLP 再发给活动监控

## Codex Adapter

仓库提供了一个 Codex adapter，会读取 `~/.codex/sessions` 和 `session_index.jsonl`，把本地会话转换成标准 OTLP logs/traces 再发给活动监控。

一次性同步最近会话：

```bash
python scripts/codex_otlp_adapter.py --limit 20
```

持续轮询同步：

```bash
python scripts/codex_otlp_adapter.py --watch --interval 10
```

自定义 bridge 地址：

```bash
python scripts/codex_otlp_adapter.py \
  --logs-endpoint http://127.0.0.1:46357/v1/logs \
  --traces-endpoint http://127.0.0.1:46357/v1/traces
```

## Claude Code

Claude Code 官方支持直接通过 OpenTelemetry 导出事件，不需要解析本地会话文件。

Anthropic 官方文档列出的关键环境变量包括：

- `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- `OTEL_LOGS_EXPORTER=otlp`
- `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:46357/v1/logs`

这套配置会把 Claude Code 的 `claude_code.user_prompt`、`claude_code.tool_result`、`claude_code.api_request` 等事件直接送进活动监控。

快速配置当前机器上的 `~/.claude/settings.json`：

```bash
python scripts/configure_claude_otlp.py --enable-tool-details
```

如果你希望同时把 prompt 原文也发进活动监控：

```bash
python scripts/configure_claude_otlp.py \
  --enable-tool-details \
  --enable-user-prompts
```

脚本只会合并 `env` 配置，不会覆盖你已有的 `permissions` 或其他 Claude 设置。

Anthropic 官方参考：

- [Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage)
- [Claude Code Settings](https://code.claude.com/docs/en/settings)

## Qwen Code

Qwen Code 当前发行版已经内置 telemetry 开关，CLI 也直接暴露了：

- `--telemetry`
- `--telemetry-target`
- `--telemetry-otlp-endpoint`
- `--telemetry-otlp-protocol`

官方文档和当前 `qwen --help` 一致，推荐把配置写进 `~/.qwen/settings.json`。

快速配置当前机器上的 `~/.qwen/settings.json`：

```bash
python scripts/configure_qwen_otlp.py
```

如果你希望同时把 prompt 原文也发进活动监控：

```bash
python scripts/configure_qwen_otlp.py --log-prompts
```

脚本会把 Qwen telemetry 配成：

- `telemetry.enabled = true`
- `telemetry.target = "local"`
- `telemetry.otlpProtocol = "http"`
- `telemetry.otlpEndpoint = "http://127.0.0.1:46357"`

这里用的是 bridge 根地址，不是单个 `/v1/logs` 路径。Qwen 的 HTTP OTLP exporter 会同时发送 logs、traces、metrics。

Qwen 官方参考：

- [Qwen Code Telemetry](https://qwenlm.github.io/qwen-code-docs/en/developers/development/telemetry/)

## 快速验证

发送 Codex logs 示例：

```bash
python scripts/send_otlp.py \
  --endpoint http://127.0.0.1:46357/v1/logs \
  --file docs/examples/codex-otlp-logs.json
```

发送 Claude traces 示例：

```bash
python scripts/send_otlp.py \
  --endpoint http://127.0.0.1:46357/v1/traces \
  --file docs/examples/claude-otlp-traces.json
```
