/**
 * PrintQ Dashboard — Core Logic (Fixed & Patched)
 */

// ─── State ───────────────────────────────────────────────────────────────────
let jobIdCounter = 200;
function nextId() {
  return ++jobIdCounter;
}

const state = {
  currentSection: "queue",
  isDarkMode: localStorage.getItem("printq-dark-mode") === "true",
  notifications: [],
  history: [],
  normalQueue: [],
  priorityQueue: Array(5).fill(null),
  queueTab: "normal",
  isPrinting: true,
  charts: {},
  stats: { pagesToday: 0 },
  analyticsFilters: {
    master: { from: "", to: "", mode: "daily" },
    revenue: { from: "", to: "", mode: "daily" },
    customers: { from: "", to: "", mode: "daily" },
    pages: { from: "", to: "", mode: "daily" },
  },
  printers: Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    name: `Machine ${i + 1}`,
    status: "IDLE",
    currentJob: null,
    progress: 0,
    completedToday: [],
  })),
  queueView: "queue",
  fillInProgress: false,
  settings: JSON.parse(localStorage.getItem("printq-settings")) || {
    bwPrice: 2,
    colorPrice: 10,
    a3Extra: 1,
    prioritySurcharges: [30, 20, 15, 10, 10],
    storeOpen: true,
    autoAdvanceDelay: 8,
  },
};

// ─── DOM ─────────────────────────────────────────────────────────────────────
const elements = {
  mainContent: document.getElementById("mainContent"),
  navItems: document.querySelectorAll(".nav-item"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  notificationBtn: document.getElementById("notificationBtn"),
  notificationDrawer: document.getElementById("notificationDrawer"),
  closeDrawer: document.getElementById("closeDrawer"),
  notificationList: document.getElementById("notificationList"),
  notificationBadge: document.getElementById("notificationBadge"),
  sidebarActivity: document.getElementById("sidebarActivity"),
  statPages: document.getElementById("statPages"),
  statNormalQueue: document.getElementById("statNormalQueue"),
  statPriorityQueue: document.getElementById("statPriorityQueue"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  setupEventListeners();
  applyDarkMode();
  loadDemoData();
  renderSection(state.currentSection);
  setTimeout(() => {
    state.printers.forEach((p) => assignNextJob(p));
  }, 1500);
  startSimulation();
}

// ─── Events ──────────────────────────────────────────────────────────────────
function setupEventListeners() {
  elements.navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const section = item.getAttribute("data-section");
      if (section) switchSection(section);
    });
  });
  elements.darkModeToggle.addEventListener("click", toggleDarkMode);
  elements.notificationBtn.addEventListener("click", () => {
    elements.notificationDrawer.classList.add("open");
    state.notifications.forEach((n) => (n.read = true));
    updateNotificationBadge();
    renderNotifications();
  });
  elements.closeDrawer.addEventListener("click", () => {
    elements.notificationDrawer.classList.remove("open");
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function switchSection(sectionId) {
  state.currentSection = sectionId;
  elements.navItems.forEach((item) => {
    item.classList.toggle(
      "active",
      item.getAttribute("data-section") === sectionId,
    );
  });
  renderSection(sectionId);
}

function renderSection(sectionId) {
  if (sectionId !== "analytics") {
    Object.values(state.charts).forEach((c) => {
      try {
        c.destroy();
      } catch (e) {}
    });
    state.charts = {};
  }
  let html = "";
  switch (sectionId) {
    case "queue":
      html = renderQueueSection();
      break;
    case "history":
      html = renderHistorySection();
      break;
    case "analytics":
      html = renderAnalyticsSection();
      break;
    case "machines":
      html = renderMachinesSection();
      break;
    case "pricing":
      html = renderPricingSection();
      break;
    case "profile":
      html = renderProfileSection();
      break;
  }
  elements.mainContent.innerHTML = html;
  if (sectionId === "analytics") initCharts();
}

// ─── Audio ────────────────────────────────────────────────────────────────────
const audio = {
  ctx: null,
  init() {
    if (!this.ctx)
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  },
  beep() {
    try {
      this.init();
      if (this.ctx.state === "suspended") this.ctx.resume();
      const play = (freq, when) => {
        const o = this.ctx.createOscillator(),
          g = this.ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(freq, when);
        o.connect(g);
        g.connect(this.ctx.destination);
        g.gain.setValueAtTime(0.1, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
        o.start(when);
        o.stop(when + 0.2);
      };
      const t = this.ctx.currentTime;
      play(880, t);
      play(1046, t + 0.22);
    } catch (e) {}
  },
};

// ─── Status Style Helpers ─────────────────────────────────────────────────────
function statusStyle(status) {
  const map = {
    WAITING: {
      bg: "var(--status-wait)",
      text: "var(--status-wait-text)",
      border: "var(--accent)",
    },
    READY_TO_PRINT: {
      bg: "var(--status-ready)",
      text: "var(--status-ready-text)",
      border: "var(--status-ready-border)",
    },
    PRINTING: {
      bg: "var(--status-process)",
      text: "var(--status-process-text)",
      border: "var(--status-process-border)",
    },
    DONE: {
      bg: "var(--status-done)",
      text: "var(--status-done-text)",
      border: "var(--status-done-border)",
    },
  };
  return map[status] || map.WAITING;
}

function statusLabel(status) {
  return (
    {
      WAITING: "Waiting",
      READY_TO_PRINT: "Ready ▶",
      PRINTING: "Printing...",
      DONE: "Done ✓",
    }[status] || status
  );
}

// ─── Queue Section ────────────────────────────────────────────────────────────
function renderQueueSection() {
  const normalActive = state.queueTab === "normal";
  const totalPages =
    state.normalQueue.reduce((a, j) => a + j.pages, 0) +
    state.priorityQueue.reduce((a, j) => (j ? a + j.pages : a), 0);
  const estWait = Math.max(
    1,
    Math.ceil((totalPages * 0.5) / Math.max(1, state.printers.length)),
  );

  return `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                ${
                  state.isPrinting
                    ? `<button onclick="stopPrinting()" style="background:var(--danger);color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;">■ Stop Printing</button>`
                    : `<button onclick="startPrinting()" style="background:var(--accent);color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;">▶ Start Printing</button>`
                }
                <div style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);">
                    <span>Printers:</span>
                    ${[1, 2, 3, 4, 5]
                      .map(
                        (
                          n,
                        ) => `<span onclick="setPrinterCount(${n})" style="padding:4px 9px;border:1px solid var(--border);border-radius:5px;cursor:pointer;font-weight:600;
                        ${state.printers.length === n ? "background:var(--accent);color:#fff;border-color:var(--accent);" : "background:var(--bg-base);color:var(--text-secondary);"}">${n}</span>`,
                      )
                      .join("")}
                </div>
                <span style="font-size:11px;color:var(--text-muted);">Est. wait: ~${estWait} min</span>
            </div>
            <div style="display:flex;background:var(--bg-base);border-radius:6px;padding:2px;border:1px solid var(--border);">
                <button onclick="switchView('queue')" style="padding:4px 12px;border:none;background:${state.queueView === "queue" ? "var(--accent)" : "transparent"};color:${state.queueView === "queue" ? "#fff" : "var(--text-secondary)"};border-radius:4px;font-size:11px;cursor:pointer;font-weight:600;">☰ Queue</button>
                <button onclick="switchView('printer')" style="padding:4px 12px;border:none;background:${state.queueView === "printer" ? "var(--accent)" : "transparent"};color:${state.queueView === "printer" ? "#fff" : "var(--text-secondary)"};border-radius:4px;font-size:11px;cursor:pointer;font-weight:600;">🖨 Printer View</button>
            </div>
        </div>

        ${
          state.queueView === "queue"
            ? `
            <div style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border);">
                <button onclick="switchQueueTab('normal')" style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:13px;
                    font-weight:${normalActive ? "600" : "400"};color:${normalActive ? "var(--accent)" : "var(--text-secondary)"};
                    border-bottom:${normalActive ? "2px solid var(--accent)" : "2px solid transparent"};margin-bottom:-2px;">
                    Normal Queue <span style="padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;
                        background:${normalActive ? "var(--accent)" : "var(--border)"};color:${normalActive ? "#fff" : "var(--text-secondary)"};margin-left:4px;">
                        ${state.normalQueue.filter((j) => j.status !== "DONE").length}</span>
                </button>
                <button onclick="switchQueueTab('priority')" style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:13px;
                    font-weight:${!normalActive ? "600" : "400"};color:${!normalActive ? "var(--accent)" : "var(--text-secondary)"};
                    border-bottom:${!normalActive ? "2px solid var(--accent)" : "2px solid transparent"};margin-bottom:-2px;">
                    Priority Queue <span style="padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;
                        background:${!normalActive ? "var(--accent)" : "var(--border)"};color:${!normalActive ? "#fff" : "var(--text-secondary)"};margin-left:4px;">
                        ${state.priorityQueue.filter(Boolean).length}/5</span>
                </button>
            </div>
            <div id="queueContent">
                ${normalActive ? renderNormalQueue() : renderPriorityQueue()}
            </div>
        `
            : renderPrinterView()
        }
    `;
}

function switchView(v) {
  state.queueView = v;
  renderSection("queue");
}
function switchQueueTab(t) {
  state.queueTab = t;
  renderSection("queue");
}

function setPrinterCount(n) {
  while (state.printers.length < n) {
    const id = state.printers.length + 1;
    state.printers.push({
      id,
      name: `Machine ${id}`,
      status: "IDLE",
      currentJob: null,
      progress: 0,
      completedToday: [],
    });
  }
  while (state.printers.length > n) {
    const removed = state.printers.pop();
    if (removed.currentJob) state.normalQueue.unshift(removed.currentJob);
  }
  if (state.isPrinting)
    state.printers.forEach((p) => {
      if (p.status === "IDLE") assignNextJob(p);
    });
  renderSection("queue");
}

function renderNormalQueue() {
  if (!state.normalQueue.length)
    return '<div style="text-align:center;padding:60px 0;color:var(--text-muted);">Queue is empty — filling up…</div>';
  return `<div id="queueList" style="display:flex;flex-direction:column;gap:10px;">
        ${state.normalQueue.map((job, i) => renderJobCard(job, null, i + 1)).join("")}
    </div>`;
}

function renderPriorityQueue() {
  const sur = state.settings.prioritySurcharges;
  return `<div style="display:flex;flex-direction:column;gap:10px;">
        ${state.priorityQueue
          .map((job, i) =>
            job
              ? renderJobCard(job, i + 1)
              : `<div class="card" ondragover="handleDragOver(event)" ondrop="handlePriorityDrop(event)" data-slot="${i}"
                style="border-style:dashed;border-color:var(--status-process-border);opacity:.5;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;">
                <div style="color:var(--text-muted);font-size:12px;">Slot ${i + 1} — Open</div>
                <div style="font-size:10px;font-weight:600;color:var(--status-process-text);background:var(--status-process);padding:2px 6px;border-radius:5px;">+₹${sur[i]}</div>
              </div>`,
          )
          .join("")}
    </div>`;
}

function renderJobCard(job, slot = null, position = null) {
  const s = statusStyle(job.status);
  const isDone = job.status === "DONE";
  const isPrint = job.status === "PRINTING";
  const isReady = job.status === "READY_TO_PRINT";
  const isActive = isPrint || isReady;
  const label = slot
    ? `Priority Slot #${slot}`
    : `Queue #${String(position).padStart(2, "0")}`;
  const draggable = !isActive && !isDone;

  return `
        <div class="card job-card"
             draggable="${draggable}"
             ondragstart="handleDragStart(event)"
             ondragover="handleDragOver(event)"
             ondrop="${slot ? "handlePriorityDrop(event)" : "handleDrop(event)"}"
             data-id="${job.id}"
             data-slot="${slot !== null ? slot - 1 : ""}"
             style="border-left:4px solid ${s.border};background:${isDone || isPrint || isReady ? s.bg : "var(--bg-surface)"};transition:background .3s,border-color .3s;">

            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
                <span class="label-small" style="color:var(--text-muted);font-size:10px;">${label}${draggable ? " ⠿" : ""}</span>
                <div style="display:flex;gap:6px;align-items:center;">
                    <span style="padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;
                                 background:${s.bg};color:${s.text};border:1px solid ${s.border};
                                 ${isPrint || isReady ? "animation:pulseBadge 1.5s infinite;" : ""}">
                        ${statusLabel(job.status)}${isActive && job.printerName ? ` (${job.printerName})` : ""}
                    </span>
                    ${!isActive && !isDone ? `<button onclick="confirmRemove(${job.id})" style="border:none;background:none;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;">✕</button>` : ""}
                </div>
            </div>

            <div style="font-weight:600;font-size:14px;color:var(--text-primary);margin-bottom:2px;line-height:1.2;">${job.docName}</div>
            <div style="font-size:11px;font-weight:500;color:var(--text-secondary);margin-bottom:2px;">${job.customerName}</div>
            <div style="font-size:10px;color:var(--text-muted);">${job.pages}p · ${job.color ? "Clr" : "B&W"} · ${job.size} · ${job.sides}-sd</div>

            <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;">
                <span style="font-weight:700;font-size:13px;color:var(--accent);">₹${job.price.toFixed(2)}${slot ? ` <span style="font-size:9px;font-weight:400;color:var(--text-muted);">(+₹${state.settings.prioritySurcharges[slot - 1]})</span>` : ""}
                </span>
                <span style="font-size:9px;color:var(--text-muted);">${timeAgo(job.time)}</span>
            </div>

            ${
              isPrint
                ? `
                <div style="margin-top:8px;">
                    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-muted);margin-bottom:2px;">
                        <span>Printing…</span><span class="progress-text">${Math.round(job.progress || 0)}%</span>
                    </div>
                    <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
                        <div class="progress-bar-fill" style="height:100%;background:var(--accent);width:${job.progress || 0}%;transition:width .15s linear;"></div>
                    </div>
                </div>`
                : ""
            }

            ${
              isDone
                ? `
                <button onclick="markCollected(${job.id})" style="width:100%;margin-top:10px;padding:8px;border:1px solid ${s.border};background:${s.bg};color:${s.text};border-radius:6px;font-weight:600;cursor:pointer;">
                    ✓ Mark Collected
                </button>`
                : ""
            }

            ${
              job.countdown > 0
                ? `
                <div style="margin-top:8px;text-align:center;font-size:11px;font-weight:600;color:var(--accent);">
                    Starting in ${job.countdown}s…
                </div>`
                : ""
            }
        </div>
    `;
}

// ─── Printer View ─────────────────────────────────────────────────────────────
function renderPrinterView() {
  return `<div class="printer-view-grid">
        ${state.printers
          .map((p) => {
            const sc = {
              IDLE: {
                bg: "var(--status-wait)",
                text: "var(--status-wait-text)",
              },
              READY_TO_PRINT: {
                bg: "var(--status-ready)",
                text: "var(--status-ready-text)",
              },
              PRINTING: {
                bg: "var(--status-process)",
                text: "var(--status-process-text)",
              },
              OFFLINE: { bg: "#666", text: "#fff" },
            }[p.status] || {
              bg: "var(--status-wait)",
              text: "var(--status-wait-text)",
            };
            const upNext = getUpNextForPrinter(p);
            return `
                <div class="printer-column">
                    <div class="printer-column-header">
                        <div style="font-weight:600;display:flex;align-items:center;gap:6px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                            ${p.name}
                        </div>
                        <span style="padding:3px 8px;border-radius:5px;font-size:10px;font-weight:700;background:${sc.bg};color:${sc.text};">${p.status}</span>
                    </div>
                    <div class="printer-section">
                        <span class="printer-section-label">In Progress</span>
                        ${p.currentJob ? renderJobCard(p.currentJob) : `<div class="card" style="border-style:dashed;opacity:.5;padding:20px;text-align:center;color:var(--text-muted);">Waiting for next job…</div>`}
                    </div>
                    <div class="printer-section">
                        <span class="printer-section-label">Up Next</span>
                        <div style="display:flex;flex-direction:column;gap:6px;">
                            ${upNext.length ? upNext.map((j) => `<div class="compact-job-card"><div style="font-weight:600;font-size:12px;color:var(--text-primary);">${j.docName}</div><div style="font-size:11px;color:var(--text-muted);">${j.customerName} · ${j.pages}p · ${j.color ? "Color" : "B&W"}</div></div>`).join("") : '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">Nothing queued</div>'}
                        </div>
                    </div>
                    <div class="printer-section">
                        <button class="collapsible-trigger" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                            Done Today (${p.completedToday.length}) <span>▼</span>
                        </button>
                        <div style="display:none;margin-top:8px;">
                            ${p.completedToday.length ? p.completedToday.map((j) => `<div style="font-size:11px;padding:6px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;color:var(--text-secondary);"><span style="color:var(--status-done-text);">✓</span><span style="flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${j.docName}</span><span style="color:var(--text-muted);">${new Date(j.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`).join("") : '<div style="font-size:11px;color:var(--text-muted);padding:6px 0;">None yet</div>'}
                        </div>
                    </div>
                </div>`;
          })
          .join("")}
    </div>`;
}

function getUpNextForPrinter(printer) {
  const all = [
    ...state.priorityQueue.filter(Boolean),
    ...state.normalQueue,
  ].filter((j) => j.status === "WAITING");
  const idx = state.printers.indexOf(printer);
  return all.filter((_, i) => i % state.printers.length === idx).slice(0, 3);
}

// ─── Machines Section ─────────────────────────────────────────────────────────
function renderMachinesSection() {
  return `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
            <h2 style="font-size:18px;font-weight:600;">Printers</h2>
            <div style="display:flex;gap:8px;">
                <button onclick="setPrinterCount(Math.max(1,state.printers.length-1));switchSection('machines')" style="padding:6px 14px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);border-radius:6px;cursor:pointer;font-weight:600;">− Remove</button>
                <button onclick="setPrinterCount(Math.min(5,state.printers.length+1));switchSection('machines')" style="padding:6px 14px;border:none;background:var(--accent);color:#fff;border-radius:6px;cursor:pointer;font-weight:600;">+ Add Machine</button>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
            ${state.printers
              .map((p) => {
                const sc = {
                  IDLE: {
                    bg: "var(--status-wait)",
                    text: "var(--status-wait-text)",
                  },
                  READY_TO_PRINT: {
                    bg: "var(--status-ready)",
                    text: "var(--status-ready-text)",
                  },
                  PRINTING: {
                    bg: "var(--status-process)",
                    text: "var(--status-process-text)",
                  },
                  OFFLINE: { bg: "#666", text: "#fff" },
                }[p.status] || {
                  bg: "var(--status-wait)",
                  text: "var(--status-wait-text)",
                };
                return `<div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                        <span style="font-weight:600;display:flex;align-items:center;gap:7px;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                            ${p.name}
                        </span>
                        <span style="padding:4px 9px;border-radius:5px;font-size:10px;font-weight:700;background:${sc.bg};color:${sc.text};">${p.status}</span>
                    </div>
                    ${
                      p.currentJob
                        ? `
                        <div style="font-size:11px;font-weight:600;margin-bottom:2px;color:var(--text-primary);">${p.currentJob.docName}</div>
                        <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px;">${p.currentJob.customerName}</div>
                        <div class="machine-progress-text" style="font-size:10px;color:var(--text-muted);margin-bottom:6px;">Page ${Math.ceil(((p.progress || 0) / 100) * p.currentJob.pages)} of ${p.currentJob.pages} · ${p.currentJob.color ? "Clr" : "B&W"}</div>
                        <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
                            <div class="machine-progress-fill" style="height:100%;background:var(--accent);width:${p.progress || 0}%;transition:width .15s;"></div>
                        </div>`
                        : `<div style="color:var(--text-muted);font-size:12px;padding:10px 0;">Waiting for next job…</div>`
                    }
                    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px;display:flex;justify-content:space-between;align-items:center;">
                        <div style="font-size:11px;color:var(--text-muted);">Done today: <strong style="color:var(--text-primary);">${p.completedToday.length}</strong></div>
                        <button onclick="toggleMachineOffline(${p.id})" style="font-size:10px;font-weight:600;background:none;border:1px solid var(--border);color:${p.status === "OFFLINE" ? "var(--status-done-text)" : "var(--danger)"};padding:3px 10px;border-radius:5px;cursor:pointer;">
                            ${p.status === "OFFLINE" ? "Set Online" : "Set Offline"}
                        </button>
                    </div>
                </div>`;
              })
              .join("")}
        </div>
    `;
}

function toggleMachineOffline(id) {
  const p = state.printers.find((p) => p.id === id);
  if (!p) return;
  if (p.status === "OFFLINE") {
    p.status = "IDLE";
    if (state.isPrinting) assignNextJob(p);
  } else {
    if (p.currentJob) {
      state.normalQueue.unshift(p.currentJob);
      p.currentJob = null;
    }
    p.status = "OFFLINE";
    p.progress = 0;
  }
  renderSection("machines");
}

// ─── History Section ──────────────────────────────────────────────────────────
function renderHistorySection() {
  const rows = state.history.slice(0, 60);
  return `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
            <h2 style="font-size:18px;font-weight:600;">Print History</h2>
            <button onclick="exportHistory()" style="padding:7px 16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-weight:600;color:var(--text-primary);font-size:12px;">↓ Export CSV</button>
        </div>
        <div class="card" style="padding:0;overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead>
                    <tr style="background:var(--bg-base);">
                        ${["Date & Time", "Customer", "Document", "Pages", "Config", "Payment", "Total ₹"].map((h) => `<th style="padding:11px 14px;text-align:${h === "Pages" || h === "Total ₹" ? "right" : "left"};font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);">${h}</th>`).join("")}
                    </tr>
                </thead>
                <tbody>
                    ${rows
                      .map(
                        (row, i) => `
                        <tr style="${i % 2 === 0 ? "background:var(--bg-surface);" : "background:var(--bg-base);"}">
                            <td style="padding:10px 14px;color:var(--text-secondary);">${row.date}</td>
                            <td style="padding:10px 14px;font-weight:500;color:var(--text-primary);">${row.customer}</td>
                            <td style="padding:10px 14px;color:var(--text-secondary);">${row.doc}</td>
                            <td style="padding:10px 14px;text-align:right;color:var(--text-primary);">${row.pages}</td>
                            <td style="padding:10px 14px;color:var(--text-muted);">${row.color ? "Color" : "B&W"} · ${row.size || "A4"}</td>
                            <td style="padding:10px 14px;">
                                <span style="padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;
                                    background:${row.payment === "Online" ? "var(--status-done)" : "var(--bg-base)"};
                                    color:${row.payment === "Online" ? "var(--status-done-text)" : "var(--text-muted)"};
                                    border:1px solid ${row.payment === "Online" ? "var(--status-done-border)" : "var(--border)"};">${row.payment || "Cash"}</span>
                            </td>
                            <td style="padding:10px 14px;text-align:right;font-weight:700;color:var(--accent);">₹${row.total.toFixed(2)}</td>
                        </tr>
                    `,
                      )
                      .join("")}
                </tbody>
            </table>
        </div>`;
}

function exportHistory() {
  let csv = "Date,Customer,Document,Pages,Color,Size,Payment,TxnID,Total\n";
  state.history.forEach((r) => {
    csv += `"${r.date}","${r.customer}","${r.doc}",${r.pages},${r.color ? "Color" : "B&W"},${r.size || "A4"},${r.payment || "Cash"},${r.txnId || ""},${r.total.toFixed(2)}\n`;
  });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: "printq_history.csv",
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Analytics Section ────────────────────────────────────────────────────────
function renderAnalyticsSection() {
  const f = state.analyticsFilters;
  const stats = calculateAnalyticsStats();
  return `
        <div class="card" style="margin-bottom:20px;">
            <div class="label-small" style="margin-bottom:12px;">Master Controls — Apply to All Charts</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
                <div style="display:flex;background:var(--bg-sidebar);border-radius:6px;padding:2px;">
                    ${["daily", "weekly", "monthly", "yearly"]
                      .map(
                        (m) => `
                        <button onclick="updateAnalyticsFilter('master','mode','${m}')" style="padding:5px 12px;border:none;border-radius:4px;font-size:11px;cursor:pointer;font-weight:600;
                            background:${f.master.mode === m ? "var(--accent)" : "transparent"};color:${f.master.mode === m ? "#fff" : "var(--sidebar-text)"};">${m.charAt(0).toUpperCase() + m.slice(1)}</button>
                    `,
                      )
                      .join("")}
                </div>
                <input type="date" value="${f.master.from}" onchange="updateAnalyticsFilter('master','from',this.value)"
                    style="background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:5px 8px;border-radius:6px;font-size:11px;">
                <span style="color:var(--text-muted);font-size:11px;">to</span>
                <input type="date" value="${f.master.to}" onchange="updateAnalyticsFilter('master','to',this.value)"
                    style="background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:5px 8px;border-radius:6px;font-size:11px;">
                <button onclick="applyMasterFilters()" style="background:var(--accent);color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">Apply to All</button>
                <button onclick="resetAnalytics()" style="background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:11px;">Reset</button>
            </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;">
            ${renderStatCard("Total Orders", stats.orders)}
            ${renderStatCard("Total Pages", stats.pages)}
            ${renderStatCard("Total Revenue", "₹ " + stats.revenue.toLocaleString("en-IN"), "var(--accent)")}
            ${renderStatCard("Avg Order Value", "₹ " + stats.avgOrder.toFixed(2))}
        </div>

        <div style="display:flex;flex-direction:column;gap:20px;">
            ${renderChartContainer("Revenue ₹ (Money Made)", "revenue", "revenueChart")}
            ${renderChartContainer("Customers Visited (Orders)", "customers", "customersChart")}
            ${renderChartContainer("Pages Printed", "pages", "pagesChart")}
        </div>
    `;
}

function renderStatCard(label, value, color) {
  return `<div class="card" style="padding:14px 16px;">
        <div class="label-small" style="margin-bottom:8px;">${label}</div>
        <div style="font-size:20px;font-weight:600;${color ? `color:${color};` : "color:var(--text-primary);"}">${value}</div>
    </div>`;
}

function renderChartContainer(title, key, chartId) {
  const f = state.analyticsFilters[key];
  const colorMap = {
    revenue: "#7B74FF",
    customers: "#5B52F0",
    pages: "#34C471",
  };
  return `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
                <div class="label-small">${title}</div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <div style="display:flex;background:var(--bg-base);border-radius:5px;padding:2px;border:1px solid var(--border);">
                        ${["daily", "weekly", "monthly", "yearly"]
                          .map(
                            (m) => `
                            <button onclick="updateChartFilter('${key}','mode','${m}')" style="padding:3px 9px;border:none;border-radius:3px;font-size:10px;cursor:pointer;font-weight:600;
                                background:${f.mode === m ? "var(--accent)" : "transparent"};color:${f.mode === m ? "#fff" : "var(--text-secondary)"};">${m.charAt(0).toUpperCase() + m.slice(1)}</button>
                        `,
                          )
                          .join("")}
                    </div>
                    <input type="date" value="${f.from}" onchange="updateChartFilter('${key}','from',this.value)"
                        style="background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:3px 6px;border-radius:5px;font-size:10px;width:110px;">
                    <input type="date" value="${f.to}" onchange="updateChartFilter('${key}','to',this.value)"
                        style="background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:3px 6px;border-radius:5px;font-size:10px;width:110px;">
                    <button onclick="applySingleChart('${key}')" style="background:var(--accent);color:#fff;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;">Apply</button>
                </div>
            </div>
            <div style="height:220px;position:relative;"><canvas id="${chartId}"></canvas></div>
        </div>`;
}

function updateChartFilter(key, field, value) {
  state.analyticsFilters[key][field] = value;
  if (field === "mode" && state.currentSection === "analytics")
    renderSection("analytics");
}

function updateAnalyticsFilter(key, field, value) {
  state.analyticsFilters[key][field] = value;
  if (state.currentSection === "analytics") renderSection("analytics");
}

function applySingleChart(key) {
  const canvasMap = {
    revenue: "revenueChart",
    customers: "customersChart",
    pages: "pagesChart",
  };
  const colorMap = {
    revenue: "#7B74FF",
    customers: "#5B52F0",
    pages: "#34C471",
  };
  const typeMap = { revenue: "line", customers: "bar", pages: "line" };
  const labelMap = {
    revenue: "Revenue (₹)",
    customers: "Orders",
    pages: "Pages",
  };
  if (state.charts[key]) {
    try {
      state.charts[key].destroy();
    } catch (e) {}
    delete state.charts[key];
  }
  renderChart(key, canvasMap[key], labelMap[key], colorMap[key], typeMap[key]);
}

function applyMasterFilters() {
  const m = state.analyticsFilters.master;
  ["revenue", "customers", "pages"].forEach((k) => {
    state.analyticsFilters[k] = { ...m };
  });
  renderSection("analytics");
}

function resetAnalytics() {
  const now = new Date();
  const thirtyAgo = new Date();
  thirtyAgo.setDate(now.getDate() - 30);
  const todayStr = now.toISOString().split("T")[0];
  const fromStr = thirtyAgo.toISOString().split("T")[0];
  ["master", "revenue", "customers", "pages"].forEach((k) => {
    state.analyticsFilters[k] = { from: fromStr, to: todayStr, mode: "daily" };
  });
  renderSection("analytics");
}

function calculateAnalyticsStats() {
  const allF = Object.entries(state.analyticsFilters)
    .filter(([k]) => k !== "master")
    .map(([, f]) => ({
      from: new Date(f.from).getTime(),
      to: new Date(f.to).getTime() + 86400000,
    }));
  const minFrom = Math.min(...allF.map((f) => f.from));
  const maxTo = Math.max(...allF.map((f) => f.to));
  const filtered = isNaN(minFrom)
    ? state.history
    : state.history.filter(
        (h) => h.timestamp >= minFrom && h.timestamp <= maxTo,
      );
  const revenue = filtered.reduce((a, h) => a + h.total, 0);
  const orders = filtered.length;
  const pages = filtered.reduce((a, h) => a + h.pages, 0);
  return {
    revenue,
    orders,
    pages,
    avgOrder: orders > 0 ? revenue / orders : 0,
  };
}

function initCharts() {
  Object.values(state.charts).forEach((c) => {
    try {
      c.destroy();
    } catch (e) {}
  });
  state.charts = {};
  renderChart("revenue", "revenueChart", "Revenue (₹)", "#7B74FF", "line");
  renderChart("customers", "customersChart", "Orders", "#5B52F0", "bar");
  renderChart("pages", "pagesChart", "Pages", "#34C471", "line");
}

function renderChart(key, canvasId, label, color, type) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const filter = state.analyticsFilters[key];
  const from = new Date(filter.from).getTime();
  const to = new Date(filter.to).getTime() + 86400000;
  const filteredData = state.history.filter(
    (h) => h.timestamp >= from && h.timestamp <= to,
  );
  const grouped = groupData(filteredData, filter.mode, key);

  if (grouped.labels.length === 0) {
    const el = document.createElement("div");
    el.style =
      "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--text-muted);pointer-events:none;";
    el.innerHTML =
      '<div style="font-size:22px;margin-bottom:6px;">📊</div><div style="font-size:12px;">No data for this range</div>';
    ctx.parentElement.style.position = "relative";
    ctx.parentElement.appendChild(el);
    return;
  }

  state.charts[key] = new Chart(ctx, {
    type,
    data: {
      labels: grouped.labels,
      datasets: [
        {
          label,
          data: grouped.values,
          borderColor: color,
          backgroundColor: type === "bar" ? color + "BB" : color + "22",
          fill: type === "line",
          tension: 0.4,
          pointRadius: type === "line" ? 3 : 0,
          borderRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) =>
              key === "revenue"
                ? ` ₹${c.parsed.y.toLocaleString("en-IN")}`
                : ` ${c.parsed.y}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#888", font: { size: 10 }, maxRotation: 45 },
          grid: { color: "rgba(128,128,128,.08)" },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#888",
            font: { size: 10 },
            callback: (v) => (key === "revenue" ? "₹" + v : v),
          },
          grid: { color: "rgba(128,128,128,.08)" },
        },
      },
    },
  });
}

function groupData(data, mode, metric) {
  const groups = {};
  [...data]
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((item) => {
      const d = new Date(item.timestamp);
      let label = "";
      if (mode === "daily")
        label = d.toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        });
      else if (mode === "weekly") {
        const wk = Math.ceil(d.getDate() / 7);
        label = `W${wk} ${d.toLocaleString("en-IN", { month: "short" })}`;
      } else if (mode === "monthly")
        label = d.toLocaleString("en-IN", { month: "short", year: "numeric" });
      else label = d.getFullYear().toString();
      const value =
        metric === "revenue" ? item.total : metric === "pages" ? item.pages : 1;
      groups[label] = (groups[label] || 0) + value;
    });
  return { labels: Object.keys(groups), values: Object.values(groups) };
}

// ─── Pricing Section ──────────────────────────────────────────────────────────
function renderPricingSection() {
  const s = state.settings;
  return `
        <h2 style="font-size:18px;font-weight:600;margin-bottom:24px;">Pricing & Settings</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div class="card">
                <div class="label-small" style="margin-bottom:16px;">Base Print Prices</div>
                <div style="display:grid;gap:12px;">
                    ${pricingInput("B&W per page (₹)", s.bwPrice, "saveSetting('bwPrice',parseFloat(this.value))", 'step="0.5"')}
                    ${pricingInput("Color per page (₹)", s.colorPrice, "saveSetting('colorPrice',parseFloat(this.value))", 'step="1"')}
                    ${pricingInput("A3 surcharge per page (₹)", s.a3Extra, "saveSetting('a3Extra',parseFloat(this.value))", 'step="0.5"')}
                </div>
            </div>
            <div class="card">
                <div class="label-small" style="margin-bottom:16px;">Priority Queue Surcharges</div>
                <div style="display:grid;gap:8px;">
                    ${s.prioritySurcharges
                      .map(
                        (v, i) => `
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                            <span style="font-size:12px;color:var(--text-secondary);">Slot ${i + 1} ${i === 0 ? '<span style="color:var(--accent);font-size:10px;">(next up)</span>' : ""}</span>
                            <input type="number" value="${v}" onchange="savePrioritySurcharge(${i},parseInt(this.value))"
                                style="width:70px;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--bg-base);color:var(--text-primary);text-align:right;font-size:12px;">
                        </div>
                    `,
                      )
                      .join("")}
                </div>
            </div>
        </div>
        <div class="card" style="margin-top:16px;background:${s.storeOpen ? "var(--status-done)" : "var(--status-wait)"};border-color:${s.storeOpen ? "var(--status-done-border)" : "var(--status-wait-text)"};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div style="font-weight:600;font-size:15px;color:${s.storeOpen ? "var(--status-done-text)" : "var(--status-wait-text)"};">Store: ${s.storeOpen ? "OPEN ✓" : "CLOSED"}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">${s.storeOpen ? "Accepting new orders from customers." : "Customers cannot place new orders."}</div>
                </div>
                <button onclick="toggleStoreStatus()" style="padding:9px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;">
                    ${s.storeOpen ? "Close Store" : "Open Store"}
                </button>
            </div>
        </div>
        <div class="card" style="margin-top:16px;background:var(--bg-base);">
            <div class="label-small" style="margin-bottom:10px;">Live Price Preview</div>
            <div style="font-size:12px;color:var(--text-secondary);display:grid;gap:6px;">
                <div>5 pages B&W, A4 = <strong style="color:var(--accent);">₹${(5 * s.bwPrice).toFixed(2)}</strong></div>
                <div>3 pages Color, A4 = <strong style="color:var(--accent);">₹${(3 * s.colorPrice).toFixed(2)}</strong></div>
                <div>4 pages B&W, A3 = <strong style="color:var(--accent);">₹${(4 * (s.bwPrice + s.a3Extra)).toFixed(2)}</strong></div>
            </div>
        </div>`;
}

function pricingInput(label, value, onchange, extra = "") {
  return `<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary);">${label}
        <input type="number" ${extra} value="${value}" onchange="${onchange}"
            style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);color:var(--text-primary);font-size:13px;">
    </label>`;
}

function saveSetting(key, value) {
  state.settings[key] = value;
  localStorage.setItem("printq-settings", JSON.stringify(state.settings));
  showSavedIndicator();
}

function savePrioritySurcharge(idx, value) {
  state.settings.prioritySurcharges[idx] = value;
  localStorage.setItem("printq-settings", JSON.stringify(state.settings));
  showSavedIndicator();
}

function showSavedIndicator() {
  let el = document.getElementById("savedIndicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "savedIndicator";
    el.style =
      "position:fixed;bottom:70px;right:24px;background:var(--status-done);color:var(--status-done-text);padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;z-index:3000;animation:slideIn .3s;";
    document.body.appendChild(el);
  }
  el.textContent = "Saved ✓";
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 2000);
}

function toggleStoreStatus() {
  state.settings.storeOpen = !state.settings.storeOpen;
  localStorage.setItem("printq-settings", JSON.stringify(state.settings));
  renderSection("pricing");
}

// ─── Profile Section ──────────────────────────────────────────────────────────
function renderProfileSection() {
  const inp = (
    label,
    val,
  ) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-secondary);">${label}
        <input type="text" value="${val}" style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);color:var(--text-primary);font-size:13px;"></label>`;
  return `
        <h2 style="font-size:18px;font-weight:600;margin-bottom:24px;">Store Profile</h2>
        <div style="display:grid;grid-template-columns:1fr 300px;gap:24px;">
            <div style="display:grid;gap:16px;">
                <div class="card">
                    <div class="label-small" style="margin-bottom:14px;">Store Identity</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        ${inp("Store Name", "PrintQ Demo Store")}
                        ${inp("Owner Name", "Rajesh Patel")}
                        ${inp("Tagline", "Print smarter. Queue better.")}
                        ${inp("Email", "store@printq.in")}
                        ${inp("Phone", "98765 43210")}
                        ${inp("WhatsApp", "98765 43210")}
                    </div>
                </div>
                <div class="card">
                    <div class="label-small" style="margin-bottom:14px;">Address</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        ${inp("Street", "Shop 12, Station Road")}
                        ${inp("City", "Rajkot")}
                        ${inp("State", "Gujarat")}
                        ${inp("PIN", "360001")}
                    </div>
                </div>
                <div class="card">
                    <div class="label-small" style="margin-bottom:14px;">Services Offered</div>
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
                        ${[
                          "B&W Printing",
                          "Color Printing",
                          "Scanning",
                          "Photocopy",
                          "Lamination",
                          "Spiral Binding",
                          "ID Card Printing",
                          "Passport Photos",
                          "A3 Printing",
                        ]
                          .map(
                            (s) => `
                            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;"><input type="checkbox" checked style="accent-color:var(--accent);"> ${s}</label>
                        `,
                          )
                          .join("")}
                    </div>
                </div>
            </div>
            <div>
                <div class="label-small" style="margin-bottom:12px;">Customer View Preview</div>
                <div class="card" style="border:2px solid var(--accent);">
                    <div style="font-size:16px;font-weight:600;color:var(--text-primary);">PrintQ Demo Store</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Rajkot, Gujarat · Open Now</div>
                    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;display:grid;gap:6px;">
                        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>B&W Print</span><strong style="color:var(--accent);">₹ ${state.settings.bwPrice.toFixed(2)}</strong></div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;"><span>Color Print</span><strong style="color:var(--accent);">₹ ${state.settings.colorPrice.toFixed(2)}</strong></div>
                    </div>
                    <button style="width:100%;margin-top:16px;padding:11px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Upload Documents</button>
                </div>
            </div>
        </div>`;
}

// ─── Printing Logic ───────────────────────────────────────────────────────────
function startPrinting() {
  state.isPrinting = true;
  audio.init();
  state.printers.forEach((p) => {
    if (p.status === "IDLE") assignNextJob(p);
  });
  renderSection("queue");
}

function stopPrinting() {
  state.isPrinting = false;
  renderSection("queue");
}

function assignNextJob(printer) {
  if (!state.isPrinting) return;
  if (printer.status !== "IDLE") return;

  let nextJob = null;
  const pIdx = state.priorityQueue.findIndex(
    (j) => j !== null && j.status === "WAITING",
  );
  if (pIdx !== -1) {
    nextJob = state.priorityQueue[pIdx];
    state.priorityQueue[pIdx] = null;
  } else {
    const nIdx = state.normalQueue.findIndex((j) => j.status === "WAITING");
    if (nIdx !== -1) nextJob = state.normalQueue.splice(nIdx, 1)[0];
  }
  if (!nextJob) return;

  printer.currentJob = nextJob;
  printer.status = "READY_TO_PRINT";
  nextJob.status = "READY_TO_PRINT";
  nextJob.printerName = printer.name;
  addNotification(
    "PRINTING_STARTED",
    `${nextJob.docName} is ready on ${printer.name}`,
  );
  updateStats();
  reRenderIfVisible();

  setTimeout(() => {
    if (!state.isPrinting || printer.status === "OFFLINE") return;
    printer.status = "PRINTING";
    nextJob.status = "PRINTING";
    nextJob.progress = 0;
    reRenderIfVisible();
    processJob(printer);
  }, 3000);
}

function processJob(printer) {
  const job = printer.currentJob;
  if (!job) return;
  const timePerPage = job.color ? 4000 : 2500;
  const totalTime = job.pages * timePerPage;
  const interval = 150;
  const step = (interval / totalTime) * 100;

  const timer = setInterval(() => {
    if (!state.isPrinting || printer.status === "OFFLINE") {
      clearInterval(timer);
      return;
    }
    printer.progress = Math.min(100, (printer.progress || 0) + step);
    job.progress = printer.progress;
    if (printer.progress >= 100) {
      clearInterval(timer);
      completeJob(printer, job);
    } else {
      updateJobProgressUI(job.id, job.progress);
      updateStats(); // Just update the stats bar text
    }
  }, interval);
}

function completeJob(printer, job) {
  job.status = "DONE";
  job.progress = 100;
  if (!state.normalQueue.includes(job)) state.normalQueue.push(job);
  printer.status = "IDLE";
  printer.progress = 0;
  printer.currentJob = null;
  printer.completedToday.unshift({ ...job, completedAt: new Date() });
  state.stats.pagesToday += job.pages;
  audio.beep();
  addNotification("PRINT_COMPLETE", `✓ ${job.docName} — ready to collect!`);
  updateStats();
  reRenderIfVisible();
  setTimeout(() => markCollected(job.id), 12000);
  startCountdown(printer);
}

function startCountdown(printer) {
  let t = state.settings.autoAdvanceDelay || 8;
  const tick = () => {
    const next =
      state.priorityQueue.find((j) => j && j.status === "WAITING") ||
      state.normalQueue.find((j) => j.status === "WAITING");
    if (next) next.countdown = t;
    reRenderIfVisible();
    if (t <= 0) {
      if (next) next.countdown = 0;
      assignNextJob(printer);
    } else {
      t--;
      setTimeout(tick, 1000);
    }
  };
  tick();
}

function confirmRemove(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  if (el.querySelector(".confirm-row")) {
    el.querySelector(".confirm-row").remove();
    return;
  }
  const row = document.createElement("div");
  row.className = "confirm-row";
  row.style =
    "margin-top:10px;display:flex;gap:8px;justify-content:flex-end;align-items:center;";
  row.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">Remove this job?</span>
        <button onclick="removeJob(${id})" style="padding:5px 12px;background:var(--danger);color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Yes, remove</button>
        <button onclick="this.closest('.confirm-row').remove()" style="padding:5px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:5px;font-size:11px;cursor:pointer;color:var(--text-primary);">Cancel</button>`;
  el.appendChild(row);
}

function removeJob(id) {
  state.normalQueue = state.normalQueue.filter((j) => j.id !== id);
  addNotification("DOC_DELETED", `Document removed from queue`);
  updateStats();
  renderSection("queue");
}

function markCollected(id) {
  state.normalQueue = state.normalQueue.filter((j) => j.id !== id);
  const pi = state.priorityQueue.findIndex((j) => j && j.id === id);
  if (pi !== -1) state.priorityQueue[pi] = null;
  updateStats();
  reRenderIfVisible();
  ensureQueueFilled();
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
let draggedId = null,
  draggedFromSlot = null;

function handleDragStart(e) {
  draggedId = e.currentTarget.getAttribute("data-id");
  draggedFromSlot = e.currentTarget.getAttribute("data-slot");
  e.dataTransfer.effectAllowed = "move";
  setTimeout(() => {
    if (e.currentTarget) e.currentTarget.style.opacity = "0.4";
  }, 0);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
}

function handleDrop(e) {
  e.preventDefault();
  const targetId = e.currentTarget.getAttribute("data-id");
  if (!targetId || draggedId === targetId) return;
  const di = state.normalQueue.findIndex((j) => j.id == draggedId);
  const ti = state.normalQueue.findIndex((j) => j.id == targetId);
  if (di > -1 && ti > -1) {
    const [moved] = state.normalQueue.splice(di, 1);
    state.normalQueue.splice(ti, 0, moved);
    renderSection("queue");
  }
}

function handlePriorityDrop(e) {
  e.preventDefault();
  const targetSlot = parseInt(e.currentTarget.getAttribute("data-slot"));
  const sourceSlot = parseInt(draggedFromSlot);
  if (isNaN(targetSlot) || isNaN(sourceSlot) || targetSlot === sourceSlot)
    return;
  const tmp = state.priorityQueue[sourceSlot];
  state.priorityQueue[sourceSlot] = state.priorityQueue[targetSlot];
  state.priorityQueue[targetSlot] = tmp;
  renderSection("queue");
}

// ─── Dark Mode ────────────────────────────────────────────────────────────────
function toggleDarkMode() {
  state.isDarkMode = !state.isDarkMode;
  localStorage.setItem("printq-dark-mode", state.isDarkMode);
  applyDarkMode();
}

function applyDarkMode() {
  document.documentElement.classList.toggle("dark", state.isDarkMode);
  const sun = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const moon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  elements.darkModeToggle.innerHTML = state.isDarkMode ? sun : moon;
}

// ─── Notifications ────────────────────────────────────────────────────────────
const notifConfig = {
  PRINT_COMPLETE: {
    icon: "✓",
    bg: "var(--status-done)",
    text: "var(--status-done-text)",
  },
  PRINTING_STARTED: {
    icon: "▶",
    bg: "var(--status-process)",
    text: "var(--status-process-text)",
  },
  DOC_QUEUED: {
    icon: "+",
    bg: "var(--status-wait)",
    text: "var(--status-wait-text)",
  },
  DOC_PRIORITY: {
    icon: "★",
    bg: "var(--status-ready)",
    text: "var(--status-ready-text)",
  },
  PAYMENT_RECEIVED: {
    icon: "₹",
    bg: "var(--status-done)",
    text: "var(--status-done-text)",
  },
  DOC_DELETED: { icon: "✕", bg: "var(--bg-base)", text: "var(--text-muted)" },
};

function addNotification(type, message) {
  const n = { id: Date.now(), type, message, time: new Date(), read: false };
  state.notifications.unshift(n);
  if (state.notifications.length > 60) state.notifications.pop();
  updateNotificationBadge();

  // Highlight critical events in sidebar
  const critical = ["PRINT_COMPLETE", "PAYMENT_RECEIVED", "DOC_PRIORITY"];
  if (critical.includes(type) || type === "PRINTING_STARTED") {
    renderSidebarActivity();
  }

  if (elements.notificationDrawer.classList.contains("open"))
    renderNotifications();
}

function updateNotificationBadge() {
  const count = state.notifications.filter((n) => !n.read).length;
  const b = elements.notificationBadge;
  if (count > 0) {
    b.textContent = count > 9 ? "9+" : count;
    b.style.cssText =
      "display:flex;position:absolute;top:2px;right:2px;min-width:16px;height:16px;background:var(--danger);border-radius:10px;font-size:9px;font-weight:700;color:#fff;align-items:center;justify-content:center;padding:0 3px;";
  } else {
    b.style.display = "none";
  }
}

function renderSidebarActivity() {
  const criticalTypes = [
    "PRINT_COMPLETE",
    "PAYMENT_RECEIVED",
    "PRINTING_STARTED",
    "DOC_PRIORITY",
  ];
  const recentCritical = state.notifications
    .filter((n) => criticalTypes.includes(n.type))
    .slice(0, 3);

  if (!recentCritical.length) {
    elements.sidebarActivity.innerHTML = "";
    return;
  }

  elements.sidebarActivity.innerHTML = `
        <div class="label-small" style="margin-bottom:12px;color:rgba(255,255,255,0.4);">Recent Activity</div>
        ${recentCritical
          .map((n) => {
            const cfg = notifConfig[n.type] || notifConfig.DOC_QUEUED;
            return `
                <div class="activity-item">
                    <div class="activity-icon" style="background:${cfg.bg};color:${cfg.text};">${cfg.icon}</div>
                    <div class="activity-content">
                        <div class="activity-msg">${n.message}</div>
                        <div class="activity-time">${timeAgo(n.time)}</div>
                    </div>
                </div>
            `;
          })
          .join("")}
    `;
}

function renderNotifications() {
  if (!state.notifications.length) {
    elements.notificationList.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px;">No notifications yet</div>';
    return;
  }
  elements.notificationList.innerHTML =
    `<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:flex-end;">
            <button onclick="state.notifications=[];renderNotifications();updateNotificationBadge();" style="font-size:11px;background:none;border:none;color:var(--text-muted);cursor:pointer;font-weight:600;">Clear all</button>
        </div>` +
    state.notifications
      .map((n) => {
        const cfg = notifConfig[n.type] || notifConfig.DOC_QUEUED;
        return `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start;border-left:3px solid ${cfg.bg};${!n.read ? "background:var(--status-wait);" : ""}">
                <span style="background:${cfg.bg};color:${cfg.text};width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${cfg.icon}</span>
                <div style="flex:1;">
                    <div style="font-size:12px;font-weight:500;color:var(--text-primary);">${n.message}</div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${timeAgo(n.time)}</div>
                </div>
            </div>`;
      })
      .join("");
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  elements.statPages.textContent = state.stats.pagesToday;
  elements.statNormalQueue.textContent = `${state.normalQueue.filter((j) => j.status !== "DONE").length} docs`;
  elements.statPriorityQueue.textContent = `${state.priorityQueue.filter(Boolean).length} / 5 slots`;
}

function reRenderIfVisible() {
  // Only do full re-render for status changes or major structural updates
  // For progress, we use targeted updates.
  if (state.currentSection === "queue" || state.currentSection === "machines") {
    // Debounce/Throttle full re-render if needed, but here we just call it sparingly
    renderSection(state.currentSection);
  }
  updateStats();
}

function updateJobProgressUI(jobId, progress) {
  const cards = document.querySelectorAll(`[data-id="${jobId}"]`);
  cards.forEach((card) => {
    const bar = card.querySelector(".progress-bar-fill");
    const text = card.querySelector(".progress-text");
    if (bar) bar.style.width = `${progress}%`;
    if (text) text.textContent = `${Math.round(progress)}%`;

    // Also update machine specific progress if visible
    const machineProgress = card.querySelector(".machine-progress-fill");
    if (machineProgress) machineProgress.style.width = `${progress}%`;
    const machineText = card.querySelector(".machine-progress-text");
    if (machineText)
      machineText.textContent = `Page ${Math.ceil((progress / 100) * state.normalQueue.find((j) => j.id === jobId)?.pages || 0)} of ...`;
  });
}

// ─── Demo Data ────────────────────────────────────────────────────────────────
const demoCustomers = [
  "Aarav Shah",
  "Priya Patel",
  "Rohan Mehta",
  "Anjali Singh",
  "Kiran Desai",
  "Vijay Kumar",
  "Sneha Joshi",
  "Arjun Nair",
  "Pooja Sharma",
  "Rahul Gupta",
  "Divya Reddy",
  "Manish Tiwari",
  "Riya Kapoor",
  "Harsh Sharma",
  "Nisha Patel",
  "Siddharth Jain",
  "Kavya Nair",
  "Aditya Verma",
  "Tanvi Desai",
  "Ravi Sharma",
];
const demoDocs = [
  "Resume_{Name}_2024.pdf",
  "PAN_Card_Copy.pdf",
  "Bank_Statement_Oct.pdf",
  "Marksheet_SEM5.pdf",
  "Offer_Letter.pdf",
  "Aadhar_Xerox.pdf",
  "Rent_Agreement.pdf",
  "Passport_Application.pdf",
  "ITR_2023-24.pdf",
  "Admit_Card_UPSC.pdf",
  "College_Bonafide.pdf",
  "Salary_Slip_Nov.pdf",
  "NOC_Letter.pdf",
  "Voter_ID_Copy.pdf",
  "Visa_Application.pdf",
  "Affidavit_Final.pdf",
  "Project_Report.pdf",
];

function createMockJob(opts = {}) {
  const customer =
    demoCustomers[Math.floor(Math.random() * demoCustomers.length)];
  const doc = demoDocs[Math.floor(Math.random() * demoDocs.length)].replace(
    "{Name}",
    customer.split(" ")[0],
  );
  const pages = Math.floor(Math.random() * 14) + 1;
  const color = Math.random() > 0.7;
  const size = Math.random() > 0.85 ? "A3" : "A4";
  const price =
    pages * (color ? state.settings.colorPrice : state.settings.bwPrice) +
    (size === "A3" ? pages * state.settings.a3Extra : 0);
  return {
    id: nextId(),
    docName: doc,
    customerName: customer,
    pages,
    color,
    size,
    sides: Math.random() > 0.5 ? 1 : 2,
    price,
    status: "WAITING",
    time: new Date(Date.now() - Math.random() * 3600000),
    progress: 0,
    countdown: 0,
    ...opts,
  };
}

function loadDemoData() {
  state.normalQueue = [
    createMockJob({
      id: 101,
      docName: "Resume_Aarav_Shah.pdf",
      customerName: "Aarav Shah",
      pages: 2,
      color: false,
      size: "A4",
      price: 4,
    }),
    createMockJob({
      id: 102,
      docName: "Thesis_Draft_V2.pdf",
      customerName: "Sneha Joshi",
      pages: 45,
      color: false,
      size: "A4",
      price: 90,
    }),
    createMockJob({
      id: 103,
      docName: "Project_Charts.pdf",
      customerName: "Vijay Kumar",
      pages: 12,
      color: true,
      size: "A3",
      price: 156,
    }),
    createMockJob({
      id: 104,
      docName: "PAN_Card_Copy.pdf",
      customerName: "Priya Patel",
      pages: 1,
      color: false,
      size: "A4",
      price: 2,
    }),
    createMockJob({
      id: 105,
      docName: "Rent_Agreement.pdf",
      customerName: "Rohan Mehta",
      pages: 8,
      color: false,
      size: "A4",
      price: 16,
    }),
    createMockJob({
      id: 106,
      docName: "Bank_Stmt_6Mon.pdf",
      customerName: "Anjali Singh",
      pages: 15,
      color: false,
      size: "A4",
      price: 30,
    }),
    createMockJob({
      id: 107,
      docName: "Offer_Letter.pdf",
      customerName: "Arjun Nair",
      pages: 5,
      color: true,
      size: "A4",
      price: 50,
    }),
  ];
  state.priorityQueue = Array(5).fill(null);
  state.priorityQueue[0] = createMockJob({
    id: 501,
    docName: "URGENT_Visa_Docs.pdf",
    customerName: "Rahul Gupta",
    pages: 20,
    color: false,
    size: "A4",
    price: 70,
  });
  state.priorityQueue[1] = createMockJob({
    id: 502,
    docName: "Passport_Scan.pdf",
    customerName: "Pooja Sharma",
    pages: 1,
    color: true,
    size: "A4",
    price: 25,
  });
  state.priorityQueue[2] = createMockJob({
    id: 503,
    docName: "Affidavit_Final.pdf",
    customerName: "Kiran Desai",
    pages: 4,
    color: false,
    size: "A4",
    price: 18,
  });
  generate120DayData();
  updateStats();
}

// ─── Analytics Data ───────────────────────────────────────────────────────────
function generate120DayData() {
  const data = [];
  const now = new Date();
  let mw = 123456789,
    mz = 987654321;
  const rnd = () => {
    mz = (36969 * (mz & 65535) + (mz >>> 16)) & 0xffffffff;
    mw = (18000 * (mw & 65535) + (mw >>> 16)) & 0xffffffff;
    return (((mz << 16) + mw) & 0xffffffff) / 0x100000000 + 0.5;
  };
  const payments = ["Online", "Online", "Online", "Cash"];
  for (let i = 0; i < 120; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const isWk = date.getDay() === 0 || date.getDay() === 6;
    let count = isWk ? Math.floor(rnd() * 5) + 6 : Math.floor(rnd() * 11) + 12;
    const dom = date.getDate();
    if (dom === 15) count = Math.floor(count * 1.4);
    if (dom >= 28) count = Math.floor(count * 1.35);
    if (i >= 40 && i <= 47) count = Math.floor(count * 1.6);
    for (let j = 0; j < count; j++) {
      const pages = Math.floor(rnd() * 9) + 4,
        isColor = rnd() > 0.7,
        size = rnd() > 0.85 ? "A3" : "A4";
      const price =
        pages * (isColor ? state.settings.colorPrice : state.settings.bwPrice) +
        (size === "A3" ? pages * state.settings.a3Extra : 0);
      const payment = payments[Math.floor(rnd() * payments.length)];
      data.push({
        date: date.toLocaleDateString("en-IN"),
        timestamp: date.getTime() + Math.floor(rnd() * 86400000),
        customer: demoCustomers[Math.floor(rnd() * demoCustomers.length)],
        doc: demoDocs[Math.floor(rnd() * demoDocs.length)],
        pages,
        color: isColor,
        size,
        total: price,
        payment,
        txnId:
          payment === "Online"
            ? "TXN-" + Math.floor(rnd() * 900000 + 100000)
            : "",
      });
    }
  }
  state.history = data.sort((a, b) => b.timestamp - a.timestamp);
  const thirtyAgo = new Date();
  thirtyAgo.setDate(now.getDate() - 30);
  const todayStr = now.toISOString().split("T")[0],
    fromStr = thirtyAgo.toISOString().split("T")[0];
  ["master", "revenue", "customers", "pages"].forEach((k) => {
    state.analyticsFilters[k].from = fromStr;
    state.analyticsFilters[k].to = todayStr;
    if (!state.analyticsFilters[k].mode)
      state.analyticsFilters[k].mode = "daily";
  });
}

// ─── Queue Auto-Fill ──────────────────────────────────────────────────────────
async function ensureQueueFilled() {
  if (state.fillInProgress) return;
  state.fillInProgress = true;
  while (state.normalQueue.filter((j) => j.status !== "DONE").length < 10) {
    await addMockJobOrganic("normal");
  }
  let filled = state.priorityQueue.filter(Boolean).length;
  while (filled < 3) {
    const ei = state.priorityQueue.findIndex((j) => j === null);
    if (ei === -1) break;
    await addMockJobOrganic("priority", ei);
    filled = state.priorityQueue.filter(Boolean).length;
  }
  state.fillInProgress = false;
  updateStats();
}

function addMockJobOrganic(type, slot = null) {
  return new Promise((resolve) => {
    setTimeout(
      () => {
        const job = createMockJob();
        if (type === "priority" && slot !== null) {
          state.priorityQueue[slot] = job;
          addNotification(
            "DOC_PRIORITY",
            `${job.docName} added to Priority Slot ${slot + 1}`,
          );
        } else {
          state.normalQueue.push(job);
          addNotification(
            "DOC_QUEUED",
            `${job.docName} queued by ${job.customerName}`,
          );
        }
        if (state.currentSection === "queue") renderSection("queue");
        updateStats();
        if (state.isPrinting)
          state.printers.forEach((p) => {
            if (p.status === "IDLE") assignNextJob(p);
          });
        resolve();
      },
      Math.random() * 1500 + 1500,
    );
  });
}

// ─── Simulation Loop ──────────────────────────────────────────────────────────
function startSimulation() {
  setInterval(() => {
    if (state.normalQueue.filter((j) => j.status !== "DONE").length < 5)
      ensureQueueFilled();
  }, 20000);
  setInterval(() => {
    if (Math.random() > 0.4) {
      const c = demoCustomers[Math.floor(Math.random() * demoCustomers.length)];
      const amt = (Math.floor(Math.random() * 10) + 2) * state.settings.bwPrice;
      addNotification("PAYMENT_RECEIVED", `Payment ₹${amt} received from ${c}`);
    }
  }, 28000);
}

// ─── Inject animation keyframes ───────────────────────────────────────────────
(function () {
  const s = document.createElement("style");
  s.textContent = `@keyframes pulseBadge{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.65;transform:scale(1.08);}}`;
  document.head.appendChild(s);
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
