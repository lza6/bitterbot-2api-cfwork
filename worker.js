/**
 * =================================================================================
 * 项目: BitterBot-2API (Cloudflare Worker 终极修正版)
 * 版本: 2.2.0 (JSON 递归拆包修复版)
 * 作者: 首席AI执行官
 * 日期: 2026-01-13
 *
 * [v2.2.0 关键修复]
 * 针对用户反馈的 "JSON 源码泄露" 问题，增加了递归拆包逻辑。
 * 即使上游把 JSON 对象封装在 content 字符串里，本代码也能将其识别、拆解并正确提取文本。
 * =================================================================================
 */

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "BitterBot-2API",
  PROJECT_VERSION: "2.2.0",
  API_MASTER_KEY: "1", // 请在 Cloudflare 环境变量中设置 API_MASTER_KEY 以覆盖
  UPSTREAM_BASE: "https://bitterbot-core-production.up.railway.app",
  ORIGIN: "https://bitterbot.ai",
  REFERER: "https://bitterbot.ai/",
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  MODELS: ["bitterbot-default", "bitterbot-reasoning"],
  DEFAULT_MODEL: "bitterbot-default",
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request, apiKey);
    if (url.pathname.startsWith('/v1/')) return handleApi(request, apiKey);
    return createErrorResponse(`Not Found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 逻辑] ---
async function handleApi(request, apiKey) {
  if (apiKey) {
    const auth = request.headers.get('Authorization');
    if (!auth || auth.substring(7) !== apiKey) {
      return createErrorResponse('Unauthorized', 401, 'unauthorized');
    }
  }

  const url = new URL(request.url);
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, requestId);
  return createErrorResponse('Not Found', 404, 'not_found');
}

function handleModelsRequest() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now()/1000, owned_by: 'bitterbot' }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function handleChatCompletions(request, requestId) {
  try {
    const reqBody = await request.json();
    const messages = reqBody.messages || [];
    const prompt = messages[messages.length - 1]?.content || "Hello";
    const model = reqBody.model || CONFIG.DEFAULT_MODEL;
    const guestId = reqBody.user || crypto.randomUUID();
    const isWebUI = reqBody.is_web_ui || false;

    // 1. 初始化请求 (Initiate)
    const formData = new FormData();
    formData.append("prompt", prompt);
    formData.append("enable_thinking", "false");
    formData.append("reasoning_effort", "low");
    formData.append("stream", "true");
    formData.append("enable_context_manager", "false");
    formData.append("guest_id", guestId);

    const initRes = await fetch(`${CONFIG.UPSTREAM_BASE}/api/agent/initiate`, {
      method: "POST",
      headers: {
        "Origin": CONFIG.ORIGIN,
        "Referer": CONFIG.REFERER,
        "User-Agent": CONFIG.USER_AGENT
      },
      body: formData
    });

    if (!initRes.ok) return createErrorResponse(`Upstream Init Failed: ${initRes.status}`, initRes.status, 'upstream_error');
    
    const initData = await initRes.json();
    const agentRunId = initData.agent_run_id || initData.id || initData.run_id;
    if (!agentRunId) return createErrorResponse("No agent_run_id returned", 502, 'upstream_error');

    // 2. 流式请求 (Stream)
    const streamUrl = `${CONFIG.UPSTREAM_BASE}/api/agent-run/${agentRunId}/stream?guest_id=${guestId}`;
    const upstreamResponse = await fetch(streamUrl, {
      method: "GET",
      headers: {
        "Accept": "text/event-stream",
        "Origin": CONFIG.ORIGIN,
        "Referer": CONFIG.REFERER,
        "User-Agent": CONFIG.USER_AGENT
      }
    });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        if (isWebUI) {
            // 发送调试信息给 WebUI
            const debugMsg = JSON.stringify({ debug: [{ step: "Init", data: `RunID: ${agentRunId}` }] });
            await writer.write(encoder.encode(`data: ${debugMsg}\n\n`));
        }

        const reader = upstreamResponse.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            
            const dataStr = trimmed.substring(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              let data = JSON.parse(dataStr);

              // === [核心修复: 递归拆包逻辑] ===
              // 检查 data.content 是否包含另一个 JSON 字符串 (Double Wrapping)
              if (data && typeof data.content === 'string') {
                  const innerContent = data.content.trim();
                  // 如果 content 看起来像 JSON 对象
                  if (innerContent.startsWith('{') && innerContent.endsWith('}')) {
                      try {
                          const innerJson = JSON.parse(innerContent);
                          // 如果内部 JSON 包含系统字段，说明这是被封装的系统消息
                          if (innerJson.status_type || innerJson.role || innerJson.thread_run_id) {
                              data = innerJson; // 替换为内部对象，进行后续处理
                          }
                      } catch (e) {
                          // 解析失败，说明它只是普通的包含花括号的文本，保持原样
                      }
                  }
              }
              // === [拆包结束] ===

              // 1. 过滤系统状态消息 (如 thread_run_start, tool_started 等)
              // 注意：有些 assistant 消息也有 status_type，所以我们只过滤没有 content 的，或者明确是系统类型的
              if (data.status_type && data.status_type !== 'assistant' && !data.content) continue;
              if (data.status_type === 'thread_run_start') continue;
              if (data.status_type === 'tool_started') continue;
              
              // 2. 过滤用户回显
              if (data.role === 'user') continue;

              // 3. 提取文本
              let contentText = "";
              if (typeof data.content === 'string') contentText = data.content;
              else if (typeof data.text === 'string') contentText = data.text;
              else if (data.choices?.[0]?.delta?.content) contentText = data.choices[0].delta.content;

              // 4. 发送有效文本
              if (contentText) {
                const chunk = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }

            } catch (e) {
              // 忽略解析错误
            }
          }
        }
        
        // 结束流
        const endChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        const errChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: `\n[Error: ${e.message}]` }, finish_reason: 'error' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }),
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第四部分: Web UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BitterBot-2API v2.2.0</title>
<style>
:root{--bg:#121212;--panel:#1E1E1E;--text:#E0E0E0;--primary:#FFBF00;}
body{font-family:sans-serif;background:var(--bg);color:var(--text);margin:0;height:100vh;display:flex;}
.sidebar{width:300px;background:var(--panel);padding:20px;border-right:1px solid #333;display:flex;flex-direction:column;gap:15px;}
.main{flex:1;padding:20px;display:flex;flex-direction:column;}
input,textarea,select,button{width:100%;background:#2A2A2A;border:1px solid #444;color:#fff;padding:10px;border-radius:4px;box-sizing:border-box;margin-bottom:5px;}
button{background:var(--primary);color:#000;font-weight:bold;cursor:pointer;border:none;}
button:hover{opacity:0.9;}
.chat-box{flex:1;background:#000;border:1px solid #333;border-radius:8px;padding:20px;overflow-y:auto;white-space:pre-wrap;font-family:monospace;font-size:14px;line-height:1.5;}
.msg{margin-bottom:15px;padding:10px;border-radius:5px;}
.msg.user{background:#333;align-self:flex-end;}
.msg.ai{background:#1a1a1a;border:1px solid #333;color:#ddd;}
.label{font-size:12px;color:#888;font-weight:bold;margin-bottom:5px;display:block;}
</style>
</head>
<body>
<div class="sidebar">
  <h2 style="color:var(--primary);margin:0;">BitterBot-2API <span style="font-size:12px;background:#333;padding:2px 5px;border-radius:3px;">v2.2.0</span></h2>
  <div><span class="label">API Key</span><input type="text" value="${apiKey}" readonly onclick="this.select()"></div>
  <div><span class="label">Endpoint</span><input type="text" value="${origin}/v1/chat/completions" readonly onclick="this.select()"></div>
  <div><span class="label">Model</span><select id="model"><option>bitterbot-default</option></select></div>
  <div><span class="label">Prompt</span><textarea id="prompt" rows="5">你好，请介绍一下你自己。</textarea></div>
  <button id="btn" onclick="send()">🚀 发送请求</button>
  <div id="status" style="font-size:12px;color:#666;">就绪</div>
</div>
<div class="main">
  <div class="chat-box" id="box"></div>
</div>
<script>
async function send() {
  const prompt = document.getElementById('prompt').value;
  const btn = document.getElementById('btn');
  const box = document.getElementById('box');
  
  btn.disabled = true; btn.innerText = "Thinking...";
  box.innerHTML += \`<div class="msg user">User: \${prompt}</div>\`;
  const aiDiv = document.createElement('div');
  aiDiv.className = 'msg ai';
  aiDiv.innerText = "AI: ";
  box.appendChild(aiDiv);
  
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${apiKey}'},
      body: JSON.stringify({
        model: 'bitterbot-default',
        messages: [{role: 'user', content: prompt}],
        stream: true,
        is_web_ui: true
      })
    });
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    
    while(true) {
      const {done, value} = await reader.read();
      if(done) break;
      const chunk = decoder.decode(value, {stream:true});
      const lines = chunk.split('\\n');
      for(const line of lines) {
        if(line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if(jsonStr === '[DONE]') continue;
          try {
            const json = JSON.parse(jsonStr);
            if(json.choices && json.choices[0].delta.content) {
              text += json.choices[0].delta.content;
              aiDiv.innerText = "AI: " + text;
              box.scrollTop = box.scrollHeight;
            }
          } catch(e){}
        }
      }
    }
  } catch(e) {
    aiDiv.innerText += "\\n[Error: " + e.message + "]";
  } finally {
    btn.disabled = false; btn.innerText = "🚀 发送请求";
  }
}
</script>
</body>
</html>`;
  return new Response(html, { headers: {'Content-Type': 'text/html; charset=utf-8'} });
}
