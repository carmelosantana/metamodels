# Verifying a governed paddock

Evidence before assertions: a paddock is not done until these requests come back as below.
`scripts/provision.ts` runs the matrix itself; this page is for checking by hand or reading a failure.

## before

```bash
# The model is on the upstream (from a machine that reaches it):
curl -s -m6 "$OLLAMA_URL/api/tags" | grep -o '"qwen3:8b"'

# Optional: warm a large model so the first governed call is not a cold load.
curl -s -m180 "$OLLAMA_URL/api/generate" \
  -d '{"model":"qwen3:8b","prompt":"ok","stream":false,"keep_alive":"30m","options":{"num_predict":4}}' >/dev/null
```

The flock's URL is called **from the data-plane container**. On the compose stack,
`host.docker.internal` is the host; `localhost` is the container itself.

## matrix

```bash
KEY=mm_live_…   BASE="$DATA_PLANE_URL/p/timeinvoice"   MODEL=qwen3:8b

# 200: allowed model, with the key (a real completion, OpenAI shape)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}"

# 403: a model outside the allowlist
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model":"not-allowed","messages":[{"role":"user","content":"hi"}]}'

# 403: model management, even with a key
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/pull" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d "{\"model\":\"$MODEL\"}"

# 401: no key
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[]}"
```

| Got | Means |
|-----|-------|
| 401 on the allowed call | Wrong or revoked key, or the key is not scoped to this paddock |
| 403 on the allowed call | The model is not in `--models`, or `chat` is not in `--routes` |
| 404 | No paddock with that slug, or it is disabled |
| 429 | The fence's rate limit; wait out the window |
| 502 / 503 | The data plane cannot reach `--ollama-url`, or the model is missing upstream |

## hand-off

```
OpenAI base URL : $DATA_PLANE_URL/p/timeinvoice/v1
Endpoint        : POST …/chat/completions        (native: POST /p/timeinvoice/api/chat)
Auth            : Authorization: Bearer <key>    (or x-api-key: <key>)
Model           : one of --models
```

A reasoning model returns a `reasoning` field beside `content`; read `choices[0].message.content`.
