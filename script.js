import * as webllm from "https://esm.run/@mlc-ai/web-llm";

// ==========================================
// 1. CONFIGURATION
// ==========================================
const OPENSKY_CONFIG = {
    agent_name: "Opensky",
    creator: "Hafij Shaikh"
};

const AGENT_MODEL = {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", // Recommended: Use 3B or 7B if hardware allows
    name: "Autonomous Agent",
};

// ReAct Prompt (Reason + Act)
const SYSTEM_PROMPT = `
You are ${OPENSKY_CONFIG.agent_name}, an autonomous AI agent created by ${OPENSKY_CONFIG.creator}.
Your goal is to complete complex tasks by breaking them down into steps.

### CORE BEHAVIOR ###
- Language: Roman Urdu (mixed Hindi/Urdu in English script).
- Do NOT just answer immediately. Plan, Search, Build, then Answer.
- If a tool fails, try to fix the error or use a different tool.

### RESPONSE FORMAT ###
You must respond in ONLY one of these two formats:

1. TO USE A TOOL:
THOUGHT: [Your reasoning about what to do next]
ACTION: tool_name
ARGS: {"arg1": "value1"}

2. TO FINISH:
THOUGHT: [Final summary of what you did]
ANSWER: [The final response to the user]

### AVAILABLE TOOLS ###
- search_internet(query): Search the web for current information.
- get_weather(city): Get current weather.
- generate_image(prompt): Create an image from text.
- generate_chart(labels, values): Create a bar/line chart.
- get_crypto(id): Get crypto price.
- python_eval(code): Run python math code (simple calculations).
`;

let conversationHistory = []; 
const MAX_HISTORY = 12; 

// ==========================================
// 2. DOM & STATE
// ==========================================
const loadingScreen = document.getElementById('loadingScreen');
const chatContainer = document.getElementById('chatContainer');
const messagesArea = document.getElementById('messagesArea');
const inputText = document.getElementById('inputText');
const sendBtn = document.getElementById('sendBtn');
const sliderFill = document.getElementById('sliderFill');
const loadingPercent = document.getElementById('loadingPercent');
const loadingLabel = document.getElementById('loadingLabel');
const modelStatusContainer = document.getElementById('modelStatusContainer');
const traceList = document.getElementById('traceList');
const headerStatus = document.getElementById('headerStatus');

let agentEngine = null;
let isGenerating = false;
let currentProgress = 0;
let targetProgress = 0;
let animationFrameId = null;

// ==========================================
// 3. TOOLS (Expanded)
// ==========================================
const Tools = {
    search_internet: async (args) => {
        // Using Wikipedia API as a reliable "Search" proxy for this demo
        // In production, replace with SerpAPI/Google via a CORS proxy
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args.query)}`);
        const d = await res.json();
        if(d.title && !d.extract.includes("may refer to")) {
            return { result: `Found info: ${d.extract}`, source: d.content_urls?.desktop?.page };
        }
        return { result: "Koi specific info nahi mila. Try different keywords." };
    },
    
    get_weather: async (args) => {
        const city = args.city || args.query;
        const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}`)).json();
        if(!geo.results?.[0]) return { result: "Shehar nahi mila." };
        const { latitude, longitude, name } = geo.results[0];
        const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`)).json();
        return { result: `${name} mein temp ${w.current_weather.temperature}°C hai. Wind: ${w.current_weather.windspeed}km/h.` };
    },

    generate_image: async (args) => {
        // Using Pollinations.ai for free image generation (works client-side)
        const prompt = encodeURIComponent(args.prompt);
        const imgUrl = `https://image.pollinations.ai/prompt/${prompt}?width=512&height=512&nologo=true`;
        // Verify image loads (basic check)
        return { result: "Image ban gaya hai.", image: imgUrl };
    },

    generate_chart: async (args) => {
        return { 
            result: "Chart data ready.", 
            chart: { labels: args.labels, values: args.values, type: args.type || 'bar' } 
        };
    },

    get_crypto: async (args) => {
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${args.id}&vs_currencies=usd`);
        const d = await res.json();
        if(d[args.id]) return { result: `${args.id} price: $${d[args.id].usd}` };
        return { result: "Coin nahi mila." };
    },

    python_eval: async (args) => {
        try {
            // WARNING: eval is unsafe. For a local demo only. Use a proper sandbox for production.
            // We only allow math expressions here for safety.
            const allowed = /^[0-9+\-*/().%\s]+$/;
            if (!allowed.test(args.code)) return { result: "Invalid code (only math allowed)." };
            const result = eval(args.code);
            return { result: `Calculation result: ${result}` };
        } catch(e) {
            return { result: "Calculation mein error." };
        }
    }
};

// ==========================================
// 4. UI RENDERING
// ==========================================

function addTraceStep(type, content, status = 'running') {
    const step = document.createElement('div');
    step.className = `trace-item trace-${type} trace-${status}`;
    
    let icon = '💭';
    if (type === 'tool') icon = '🛠️';
    if (type === 'error') icon = '❌';
    if (type === 'finish') icon = '✅';

    step.innerHTML = `
        <div class="trace-icon">${icon}</div>
        <div class="trace-content">
            <div class="trace-title">${type.toUpperCase()}</div>
            <div class="trace-text">${escapeHtml(content)}</div>
        </div>
    `;
    traceList.appendChild(step);
    traceList.scrollTop = traceList.scrollHeight;
    return step;
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateTraceStatus(step, status, newContent) {
    step.className = step.className.replace(/trace-(running|done)/, `trace-${status}`);
    if (newContent) step.querySelector('.trace-text').textContent = newContent;
}

// ==========================================
// 5. AUTONOMOUS LOOP
// ==========================================

async function runAgentLoop(query) {
    // User Message
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.innerHTML = `<div class="user-bubble">${query}</div>`;
    messagesArea.appendChild(userMsg);
    messagesArea.scrollTop = messagesArea.scrollHeight;

    // Assistant Container (No Bubble)
    const assistantMsg = document.createElement('div');
    assistantMsg.className = 'message assistant';
    const contentDiv = document.createElement('div');
    assistantMsg.appendChild(contentDiv);
    messagesArea.appendChild(assistantMsg);

    // Context Management
    if (conversationHistory.length > MAX_HISTORY) conversationHistory.splice(0, 2);
    
    let messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversationHistory,
        { role: "user", content: query }
    ];

    let loopCount = 0;
    const MAX_LOOPS = 5; // Safety break
    let finalAnswer = "";
    let lastStep = null;

    try {
        while (loopCount < MAX_LOOPS) {
            headerStatus.textContent = `Thinking (Step ${loopCount + 1})...`;
            
            // 1. Generate Thought/Action
            const completion = await agentEngine.chat.completions.create({
                messages: messages, temperature: 0.1, stream: true // Low temp for logic
            });

            let currentText = "";
            let textNode = document.createTextNode("...");
            contentDiv.innerHTML = ""; // Clear previous loading states
            contentDiv.appendChild(textNode);

            for await (const chunk of completion) {
                if (!isGenerating) throw new Error("Stopped by user");
                const delta = chunk.choices[0].delta.content;
                if (delta) {
                    currentText += delta;
                    textNode.nodeValue = currentText;
                    messagesArea.scrollTop = messagesArea.scrollHeight;
                }
            }

            // 2. Parse Response
            const actionMatch = currentText.match(/ACTION:\s*(\w+)\s*ARGS:\s*(\{[\s\S]*?\})/i);
            const answerMatch = currentText.match(/ANSWER:\s*([\s\S]*)/i);
            const thoughtMatch = currentText.match(/THOUGHT:\s*([^\n]+)/i);

            // Log Thought
            if (thoughtMatch) {
                lastStep = addTraceStep("thought", thoughtMatch[1]);
            }

            // 3. Decision Tree
            
            // CASE A: Use Tool
            if (actionMatch) {
                const toolName = actionMatch[1].toLowerCase();
                let toolArgs = {};
                
                try {
                    // Clean JSON (sometimes model forgets commas or quotes)
                    let jsonStr = actionMatch[2].replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":');
                    toolArgs = JSON.parse(jsonStr);
                } catch (e) {
                    // Retry logic could go here, but for now we report error
                    const errorStep = addTraceStep("error", "JSON Parse Error");
                    messages.push({ role: "assistant", content: currentText });
                    messages.push({ role: "user", content: "Error: Invalid JSON arguments. Please fix the JSON format." });
                    loopCount++;
                    continue;
                }

                const toolStep = addTraceStep("tool", `${toolName}(${JSON.stringify(toolArgs)})`);
                
                // Execute Tool
                let observation = "";
                try {
                    if (Tools[toolName]) {
                        const result = await Tools[toolName](toolArgs);
                        observation = JSON.stringify(result);
                        
                        // Handle Visuals
                        if (result.image) {
                            contentDiv.innerHTML += `<img src="${result.image}" class="agent-image" alt="Generated Image">`;
                        }
                        if (result.chart) {
                            const chartId = 'chart_' + Math.random().toString(36).substr(2, 9);
                            contentDiv.innerHTML += `<div class="chart-card"><canvas id="${chartId}"></canvas></div>`;
                            setTimeout(() => {
                                const ctx = document.getElementById(chartId);
                                if(ctx) new Chart(ctx, { 
                                    type: result.chart.type, 
                                    data: { labels: result.chart.labels, datasets: [{ label: 'Data', data: result.chart.values, backgroundColor: 'rgba(0,0,0,0.1)', borderColor: '#000' }] },
                                    options: { responsive: true, maintainAspectRatio: false }
                                });
                            }, 50);
                        }
                        updateTraceStatus(toolStep, 'done', result.result);
                    } else {
                        observation = "Error: Tool not found.";
                        updateTraceStatus(toolStep, 'error', "Tool not found");
                    }
                } catch (e) {
                    observation = `Tool Error: ${e.message}`;
                    updateTraceStatus(toolStep, 'error', e.message);
                }

                // Feed back to model
                messages.push({ role: "assistant", content: currentText });
                messages.push({ role: "user", content: `Observation: ${observation}` });
                loopCount++;
            } 
            // CASE B: Final Answer
            else if (answerMatch) {
                finalAnswer = answerMatch[1];
                addTraceStep("finish", "Task Complete");
                break; // Exit loop
            } 
            // CASE C: Ambiguous / Need to push
            else {
                // If model just rambled without format, force it to answer
                messages.push({ role: "assistant", content: currentText });
                messages.push({ role: "user", content: "Please provide the final ANSWER now or use a TOOL." });
                loopCount++;
            }
        }

        // Render Final Markdown
        parseAndRender(finalAnswer || contentDiv.innerText, contentDiv);

    } catch (e) {
        contentDiv.innerHTML += `<span style="color:red; font-size:0.8em; display:block;">Task Interrupted: ${e.message}</span>`;
    } finally {
        isGenerating = false;
        sendBtn.classList.remove('stop-btn');
        sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
        headerStatus.textContent = "Ready";
        
        // Save to history
        conversationHistory.push({ role: "user", content: query });
        conversationHistory.push({ role: "assistant", content: finalAnswer });
    }
}

// ==========================================
// 6. HELPERS & INIT
// ==========================================

function parseAndRender(text, container) {
    // Basic Markdown
    let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Code blocks
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => 
        `<div class="code-block"><div class="code-header"><span>${lang||'code'}</span></div><pre>${code}</pre></div>`
    );
    container.innerHTML = html.replace(/\n/g, '<br>');
}

function animateProgress() {
    const diff = targetProgress - currentProgress;
    if (Math.abs(diff) > 0.05) {
        currentProgress += diff * 0.08;
        sliderFill.style.width = `${currentProgress}%`;
        loadingPercent.textContent = `${currentProgress.toFixed(2)}%`;
    }
    animationFrameId = requestAnimationFrame(animateProgress);
}

async function init() {
    try {
        loadingLabel.textContent = "Checking GPU...";
        if (!navigator.gpu) throw new Error("WebGPU not supported.");

        modelStatusContainer.innerHTML = `<div class="model-card"><div class="model-card-name">${AGENT_MODEL.name}</div><div class="model-card-desc" id="status-agent">Loading Weights...</div></div>`;

        cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(animateProgress);

        agentEngine = await webllm.CreateMLCEngine(AGENT_MODEL.id, {
            initProgressCallback: (report) => {
                targetProgress = report.progress * 100;
                document.getElementById('status-agent').textContent = report.text;
            }
        });

        targetProgress = 100;
        document.getElementById('status-agent').textContent = "Ready";
        
        setTimeout(() => {
            loadingScreen.classList.add('hidden');
            chatContainer.classList.add('active');
            sendBtn.disabled = false;
        }, 800);

    } catch (e) { 
        cancelAnimationFrame(animationFrameId);
        document.getElementById('debugLog').style.display = 'block';
        document.getElementById('debugLog').innerHTML = `Error: ${e.message}`; 
    }
}

// ==========================================
// 7. EVENTS
// ==========================================

async function handleAction() {
    const text = inputText.value.trim();
    if (!text) return;

    if (isGenerating) {
        isGenerating = false;
        agentEngine.interruptGenerate();
        return;
    }

    inputText.value = '';
    inputText.style.height = 'auto';
    isGenerating = true;
    sendBtn.classList.add('stop-btn');
    sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;
    
    await runAgentLoop(text);
}

inputText.oninput = function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px'; };
inputText.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAction(); } };
sendBtn.onclick = handleAction;
document.getElementById('clearTraceBtn').onclick = () => { traceList.innerHTML = ''; };

init();
