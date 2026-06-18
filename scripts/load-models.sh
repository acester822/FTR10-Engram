#!/bin/sh
set -eu

OLLAMA_URL="${OLLAMA_URL:-http://ollama:11434}"
HOT_MODEL="${HOT_MODEL:-qwen3.5:2b}"

MODELS_DOWNLOAD="
qwen3-embedding:0.6b
qwen2.5:3b
qwen3.5:2b
bge-m3
"

echo "⏳ Waiting for Ollama..."
until node -e "
  fetch('${OLLAMA_URL}/api/version')
    .then(r => { if (!r.ok) process.exit(1) })
    .catch(() => process.exit(1))
" >/dev/null 2>&1; do
  sleep 1
done
echo "✅ Ollama is ready"

echo "🔍 Reading installed models..."
INSTALLED="$(
  node -e "
    fetch('${OLLAMA_URL}/api/tags')
      .then(r => r.json())
      .then(d => console.log((d.models || []).map(m => m.name).join('\n')))
      .catch(() => process.exit(1))
  "
)"

echo "📥 Ensuring all required models are downloaded..."
printf '%s\n' "$MODELS_DOWNLOAD" | while IFS= read -r MODEL; do
  [ -z "$MODEL" ] && continue

  if printf '%s\n' "$INSTALLED" | grep -Fxq "$MODEL"; then
    echo "✅ $MODEL already downloaded"
  else
    echo "⬇️  Pulling $MODEL..."
    node -e "
      fetch('${OLLAMA_URL}/api/pull', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: '$MODEL',
          stream: false
        })
      })
      .then(r => { if (!r.ok) process.exit(1) })
      .catch(() => process.exit(1))
    "
    echo "✅ $MODEL downloaded"
  fi
done

echo ""
echo "📌 Loading hot model permanently: ${HOT_MODEL}"
node -e "
  fetch('${OLLAMA_URL}/api/generate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: '${HOT_MODEL}',
      prompt: '\n\n/no_think',
      keep_alive: -1,
      stream: false,
      think: false,
      options: {
        num_ctx: 2048,
        num_batch: 512
      }
    })
  })
  .then(r => { if (!r.ok) process.exit(1) })
  .catch(() => process.exit(1))
"
echo "✅ ${HOT_MODEL} is now pinned in memory"

echo ""
echo "🔍 Verifying loaded models..."
node -e "
  fetch('${OLLAMA_URL}/api/ps')
    .then(r => r.json())
    .then(d => {
      const models = d.models || [];
      console.log('Currently loaded models:');
      if (!models.length) {
        console.log(' - none');
      } else {
        for (const m of models) {
          console.log(
            ' - ' + m.name +
            ' | processor: ' + (m.processor || 'unknown') +
            ' | context: ' + (m.context || m.details?.context_length || 'unknown') +
            ' | until: ' + (m.expires_at || 'persistent')
          );
        }
      }
    })
    .catch(() => process.exit(1))
"

echo ""
echo "✅ Final state:"
echo "   - qwen3.5:2b: loaded permanently (MUST stay running)"
echo "   - qwen2.5:3b: downloaded only (fallback for generative tasks)"
echo "   - qwen3-embedding:0.6b: downloaded only"
echo "   - bge-m3: downloaded only (fallback for embeddings)"