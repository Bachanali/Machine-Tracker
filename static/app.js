/* ============================================================
   Shared helpers
   ============================================================ */

let REFERENCE = null;
let REFERENCE_UNIT = null;
let UNITS = null;
let charts = {};

const ACCENT = "#1668c4";
const PALETTE = ["#1668c4", "#17998f", "#cc8420", "#5b7aa8", "#7048c0", "#1f9d6b", "#d1495b", "#3d9be0"];

function setBtnLoading(btn, loading, loadingText = "Saving&hellip;") {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="btn-spinner"></span> ${loadingText}`;
    btn.disabled = true;
  } else {
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    btn.disabled = false;
  }
}

function toast(msg, ms = 1400) {
  const t = document.getElementById("saveToast");
  if (!t) return;
  t.classList.remove("toast-error");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

function toastError(msg, ms = 2600) {
  const t = document.getElementById("saveToast");
  if (!t) return;
  t.classList.add("toast-error");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => { t.classList.remove("show"); t.classList.remove("toast-error"); }, ms);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirmModalBackdrop");
    const msgEl = document.getElementById("confirmMessage");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    if (!backdrop) { resolve(window.confirm(message)); return; }

    msgEl.textContent = message;
    backdrop.classList.add("open");

    function cleanup(result) {
      backdrop.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdrop);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === backdrop) cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
  });
}

async function loadReference(force = false, unit = "") {
  // `unit` may be a single unit name or an array of them. With several units
  // selected we ask for all of them so the machine list is the UNION across
  // the whole selection, instead of just the first unit's machines.
  const units = (Array.isArray(unit) ? unit : (unit ? [unit] : [])).filter(Boolean);
  const cacheKey = units.join("|");
  if (REFERENCE && !force && REFERENCE_UNIT === cacheKey) return REFERENCE;
  const qs = new URLSearchParams();
  units.forEach((u) => qs.append("unit", u));
  const params = qs.toString() ? ("?" + qs.toString()) : "";
  const res = await fetch("/api/reference" + params);
  REFERENCE = await res.json();
  REFERENCE_UNIT = cacheKey;
  return REFERENCE;
}

async function loadUnits(force = false) {
  if (UNITS && !force) return UNITS;
  const res = await fetch("/api/units");
  UNITS = await res.json();
  return UNITS;
}

/* ============================================================
   Generic multi-select dropdown (checkbox list) — replaces native
   <select> for every categorical filter (Unit, Machine, Machine #,
   Shift, Technician, Fault) across Dashboard, Logs and Reports so more
   than one value can be chosen at once.
   ============================================================ */
class MultiSelect {
  constructor(rootEl, { placeholder = "All", onChange = null } = {}) {
    this.root = rootEl;
    this.placeholder = placeholder;
    this.onChange = onChange;
    this.options = [];
    this.selected = new Set();
    this._render();
  }

  _render() {
    this.root.classList.add("ms");
    this.root.innerHTML = `
      <button type="button" class="ms-trigger">${escapeHtml(this.placeholder)}</button>
      <div class="ms-panel">
        <div class="ms-search"><input type="text" placeholder="Search&hellip;"></div>
        <div class="ms-options"></div>
        <div class="ms-actions">
          <button type="button" class="ms-clear-btn">Clear</button>
        </div>
      </div>
    `;
    this.trigger = this.root.querySelector(".ms-trigger");
    this.panel = this.root.querySelector(".ms-panel");
    this.searchInput = this.root.querySelector(".ms-search input");
    this.optionsEl = this.root.querySelector(".ms-options");
    this.clearBtn = this.root.querySelector(".ms-clear-btn");

    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this._togglePanel();
    });
    this.searchInput.addEventListener("input", () => this._renderOptions());
    this.panel.addEventListener("click", (e) => e.stopPropagation());
    this.clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
      if (this.onChange) this.onChange(this.getValues());
    });
    if (!MultiSelect._globalListenerAdded) {
      document.addEventListener("click", () => {
        document.querySelectorAll(".ms-panel.open").forEach((p) => p.classList.remove("open"));
      });
      MultiSelect._globalListenerAdded = true;
    }
  }

  _togglePanel() {
    const isOpen = this.panel.classList.contains("open");
    document.querySelectorAll(".ms-panel.open").forEach((p) => p.classList.remove("open"));
    if (!isOpen) {
      this.panel.classList.add("open");
      this.searchInput.value = "";
      this._renderOptions();
    }
  }

  setOptions(options, keepSelection = true) {
    this.options = options || [];
    if (!keepSelection) {
      this.selected.clear();
    } else {
      this.selected = new Set([...this.selected].filter((v) => this.options.includes(v)));
    }
    this._renderOptions();
    this._updateTrigger();
  }

  _renderOptions() {
    const q = (this.searchInput.value || "").toLowerCase();
    const filtered = this.options.filter((o) => o.toLowerCase().includes(q));
    if (!filtered.length) {
      this.optionsEl.innerHTML = `<div class="ms-empty">No options</div>`;
      return;
    }
    this.optionsEl.innerHTML = filtered.map((o) => `
      <label class="ms-option">
        <input type="checkbox" value="${escapeHtml(o)}" ${this.selected.has(o) ? "checked" : ""}>
        <span>${escapeHtml(o)}</span>
      </label>
    `).join("");
    this.optionsEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(cb.value);
        else this.selected.delete(cb.value);
        this._updateTrigger();
        if (this.onChange) this.onChange(this.getValues());
      });
    });
  }

  _updateTrigger() {
    const n = this.selected.size;
    this.trigger.textContent = n === 0 ? this.placeholder : (n === 1 ? [...this.selected][0] : `${n} selected`);
    this.trigger.classList.toggle("ms-active", n > 0);
  }

  getValues() { return [...this.selected]; }

  setValues(arr) {
    this.selected = new Set((arr || []).filter((v) => this.options.includes(v)));
    this._renderOptions();
    this._updateTrigger();
  }

  clear() {
    this.selected.clear();
    this._renderOptions();
    this._updateTrigger();
  }
}

function fillSelect(sel, options, keepFirst = true) {
  if (!sel) return;
  const existing = keepFirst ? [sel.options[0]] : [];
  sel.innerHTML = "";
  existing.forEach((o) => o && sel.appendChild(o));
  options.forEach((opt) => {
    const o = document.createElement("option");
    const isObj = opt && typeof opt === "object";
    o.value = isObj ? opt.value : opt;
    o.textContent = isObj ? opt.label : opt;
    sel.appendChild(o);
  });
}

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function computeDowntimeStr(start, finish) {
  const s = timeToMinutes(start), f = timeToMinutes(finish);
  if (s === null || f === null) return "";
  let diff = f - s;
  if (diff < 0) diff += 24 * 60;
  const h = Math.floor(diff / 60), m = diff % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fmtMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ============================================================
   Add Data page
   ============================================================ */

function updateDowntimePreview() {
  const s = document.getElementById("f_timeStart").value;
  const f = document.getElementById("f_timeFinish").value;
  document.getElementById("downtimePreview").textContent = computeDowntimeStr(s, f) || "--:--";
}

let ADD_TECH_MS = null;

async function initAddDataPage() {
  const units = await loadUnits();
  fillSelect(document.getElementById("f_unit"), units.map((u) => u.name));

  const ref = await loadReference();
  fillSelect(document.getElementById("f_shift"), ref.shifts);
  fillSelect(document.getElementById("f_faultCategory"), ref.faultCategories);
  ADD_TECH_MS = new MultiSelect(document.getElementById("f_technician"), { placeholder: "Select technician(s)" });
  ADD_TECH_MS.setOptions(ref.technicians, false);
  fillSelect(document.getElementById("f_complaintReference"), ref.complaintReferences || []);
  fillSelect(document.getElementById("f_notificationType"), ref.notificationTypes || []);
  fillSelect(document.getElementById("f_deviceDetail"), ref.deviceDetails || []);
  fillSelect(document.getElementById("f_deviceSubCat"), ref.deviceSubCategories || []);

  // if only one unit exists, auto-select it and load its machines right away
  if (units.length === 1) {
    document.getElementById("f_unit").value = units[0].name;
    const scoped = await loadReference(true, units[0].name);
    fillSelect(document.getElementById("f_machine"), scoped.machines);
  }

  document.getElementById("f_unit").addEventListener("change", async (e) => {
    const unit = e.target.value;
    const machineSel = document.getElementById("f_machine");
    if (!unit) {
      fillSelect(machineSel, []);
      machineSel.options[0].textContent = "Select unit first";
      return;
    }
    const scoped = await loadReference(true, unit);
    fillSelect(machineSel, scoped.machines);
    machineSel.options[0].textContent = "Select machine";
  });

  document.getElementById("f_date").value = todayStr();
  document.getElementById("f_timeStart").addEventListener("input", updateDowntimePreview);
  document.getElementById("f_timeFinish").addEventListener("input", updateDowntimePreview);

  const form = document.getElementById("entryForm");
  const errBox = document.getElementById("formError");
  const okBox = document.getElementById("formSuccess");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.remove("show");
    okBox.classList.remove("show");

    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    payload.technician = ADD_TECH_MS ? ADD_TECH_MS.getValues() : [];
    const required = ["date", "unit", "machine", "faultCategory", "shift", "timeStart", "timeFinish"];
    const missing = required.filter((k) => !payload[k]);
    if (!payload.technician.length) missing.push("technician");
    if (missing.length) {
      errBox.textContent = "Please fill required fields: " + missing.join(", ");
      errBox.classList.add("show");
      return;
    }

    const submitBtn = document.getElementById("entrySubmitBtn");
    setBtnLoading(submitBtn, true);

    const res = await fetch("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setBtnLoading(submitBtn, false);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errBox.textContent = err.error || "Something went wrong.";
      errBox.classList.add("show");
      return;
    }

    const saved = await res.json().catch(() => null);
    okBox.classList.add("show");
    toast("Entry saved");
    if (saved) addToSessionList(saved);

    const keepUnit = document.getElementById("f_unit").value;
    form.reset();
    if (ADD_TECH_MS) ADD_TECH_MS.clear();
    document.getElementById("f_date").value = todayStr();
    document.getElementById("downtimePreview").textContent = "--:--";
    if (keepUnit) {
      document.getElementById("f_unit").value = keepUnit;
      const scoped = await loadReference(true, keepUnit);
      fillSelect(document.getElementById("f_machine"), scoped.machines);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

let sessionEntries = [];

function addToSessionList(rec) {
  sessionEntries.unshift(rec);
  renderSessionList();
}

function renderSessionList() {
  const countEl = document.getElementById("sessionCount");
  const listEl = document.getElementById("sessionList");
  if (!countEl || !listEl) return;

  if (!sessionEntries.length) {
    countEl.textContent = "No entries yet.";
    listEl.innerHTML = "";
    return;
  }

  countEl.textContent = `${sessionEntries.length} entr${sessionEntries.length === 1 ? "y" : "ies"} added this session.`;
  listEl.innerHTML = sessionEntries.map((r) => `
    <div class="session-item">
      <div class="session-item-top">
        <span class="session-item-machine">${escapeHtml(r.machine)}${r.machineNo ? " #" + escapeHtml(r.machineNo) : ""}</span>
        <span class="session-item-downtime">${escapeHtml(r.downtime)}</span>
      </div>
      <div class="session-item-meta">${escapeHtml(r.date)} · ${escapeHtml(r.faultCategory)} · ${escapeHtml(r.technician)}</div>
    </div>
  `).join("");
}

/* ============================================================
   Dashboard page
   ============================================================ */

function baseChartOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, ticks: { color: "#64748b", font: { size: 11 } }, grid: { color: "#e6ebf1" } },
      y: { beginAtZero: true, ticks: { color: "#64748b", font: { size: 11 } }, grid: { color: "#e6ebf1" } },
    },
    ...extra,
  };
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function pad2(n) { return String(n).padStart(2, "0"); }

function computeMonthYearRange(year, month) {
  if (!year) return { start: "", end: "" };
  if (!month) {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const y = parseInt(year, 10), m = parseInt(month, 10);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(lastDay)}` };
}

function computePreviousPeriod(year, month) {
  if (!year) return { start: "", end: "" };
  if (!month) {
    const py = String(parseInt(year, 10) - 1);
    return computeMonthYearRange(py, "");
  }
  let y = parseInt(year, 10), m = parseInt(month, 10) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return computeMonthYearRange(String(y), String(m));
}

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let dashHourFilter = ""; // set when the "Downtime by Hour of Day" chart is clicked

function buildDashDrillThroughUrl() {
  const f = currentDashFilters();
  const { start, end } = dashActiveDateRange();
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  f.unit.forEach((v) => params.append("unit", v));
  f.machine.forEach((v) => params.append("machine", v));
  f.machineNo.forEach((v) => params.append("machineNo", v));
  f.shift.forEach((v) => params.append("shift", v));
  f.technician.forEach((v) => params.append("technician", v));
  f.fault.forEach((v) => params.append("fault", v));
  f.complaintReference.forEach((v) => params.append("complaintReference", v));
  f.notificationType.forEach((v) => params.append("notificationType", v));
  if (f.hour) params.set("hour", f.hour);
  return "/logs?" + params.toString();
}

async function drillDownMachine(fullLabel) {
  const parts = fullLabel.split(" #");
  const name = parts[0];
  const number = parts.length > 1 ? parts.slice(1).join(" #") : "";
  const ms = DASH_MS.dashMachineFilter;
  if (!ms || !ms.options.includes(name)) return;
  ms.setValues([name]);
  await refreshCascadingFilterOptions();
  if (number) {
    const noMs = DASH_MS.dashMachineNoFilter;
    if (noMs && noMs.options.includes(number)) noMs.setValues([number]);
  }
  toast(`Filter applied: ${fullLabel}`);
  renderDashboard();
}

async function drillDownFilter(msId, value, needsCascade) {
  const ms = DASH_MS[msId];
  if (!ms || !ms.options.includes(value)) return;
  ms.setValues([value]);
  toast(`Filter applied: ${value}`);
  if (needsCascade) {
    await refreshCascadingFilterOptions();
  }
  renderDashboard();
}

let DASH_MS = {};

function currentDashFilters() {
  return {
    year: document.getElementById("dashYearFilter")?.value || "",
    month: document.getElementById("dashMonthFilter")?.value || "",
    unit: DASH_MS.dashUnitFilter?.getValues() || [],
    machine: DASH_MS.dashMachineFilter?.getValues() || [],
    machineNo: DASH_MS.dashMachineNoFilter?.getValues() || [],
    shift: DASH_MS.dashShiftFilter?.getValues() || [],
    technician: DASH_MS.dashTechnicianFilter?.getValues() || [],
    fault: DASH_MS.dashFaultFilter?.getValues() || [],
    complaintReference: DASH_MS.dashComplaintFilter?.getValues() || [],
    notificationType: DASH_MS.dashNotificationFilter?.getValues() || [],
    hour: dashHourFilter,
  };
}

async function fetchStatsFor(start, end, extra = {}) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  Object.entries(extra).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) { v.forEach((item) => { if (item) params.append(k, item); }); }
    else { params.set(k, v); }
  });
  const res = await fetch("/api/stats?" + params.toString());
  return res.json();
}

let dashCustomRange = null; // { start, end, label } when a quick-preset is active

function dashActiveDateRange() {
  if (dashCustomRange) return { start: dashCustomRange.start, end: dashCustomRange.end };
  const f = currentDashFilters();
  return computeMonthYearRange(f.year, f.month);
}

async function fetchDashboardStats() {
  const f = currentDashFilters();
  const { start, end } = dashActiveDateRange();
  return fetchStatsFor(start, end, {
    unit: f.unit, machine: f.machine, machineNo: f.machineNo, shift: f.shift, technician: f.technician, fault: f.fault, complaintReference: f.complaintReference, notificationType: f.notificationType, hour: f.hour,
  });
}

function fmtMultiBit(arr, label, allLabel) {
  if (!arr.length) return allLabel;
  const shown = arr.length <= 2 ? arr.map(escapeHtml).join(", ") : `${arr.length} selected`;
  return `${label}: <strong>${shown}</strong>`;
}

function updateDashFilterSummary() {
  const f = currentDashFilters();
  const bits = [];
  if (dashCustomRange) {
    bits.push(`<strong>${dashCustomRange.label}</strong>`);
  } else if (!f.year) {
    bits.push("<strong>Full Record (All Time)</strong>");
  } else if (!f.month) {
    bits.push(`<strong>${f.year}</strong> (whole year)`);
  } else {
    bits.push(`<strong>${MONTH_NAMES[parseInt(f.month, 10)]} ${f.year}</strong>`);
  }
  bits.push(fmtMultiBit(f.unit, "Unit", "All Units"));
  bits.push(fmtMultiBit(f.machine, "Machine", "All Machines"));
  if (f.machineNo.length) bits.push(fmtMultiBit(f.machineNo, "Machine #", ""));
  if (f.shift.length) bits.push(fmtMultiBit(f.shift, "Shift", ""));
  if (f.technician.length) bits.push(fmtMultiBit(f.technician, "Technician", ""));
  if (f.fault.length) bits.push(fmtMultiBit(f.fault, "Fault", ""));
  if (f.complaintReference.length) bits.push(fmtMultiBit(f.complaintReference, "Complaint Ref", ""));
  if (f.notificationType.length) bits.push(fmtMultiBit(f.notificationType, "Notification", ""));
  if (f.hour) bits.push(`Hour: <strong>${String(f.hour).padStart(2, "0")}:00</strong>`);
  document.getElementById("dashFilterSummary").innerHTML =
    "Showing: " + bits.filter(Boolean).join(' <span class="sep">&middot;</span> ');
  document.getElementById("dashUpdatedAt").textContent =
    "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function applyDashPreset(preset) {
  const now = new Date();
  let start, end, label;
  if (preset === "today") {
    start = end = isoDate(now); label = "Today";
  } else if (preset === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    start = end = isoDate(y); label = "Yesterday";
  } else if (preset === "thisweek") {
    const day = now.getDay() === 0 ? 7 : now.getDay(); // Mon=1..Sun=7
    const monday = new Date(now); monday.setDate(now.getDate() - (day - 1));
    start = isoDate(monday); end = isoDate(now); label = "This Week";
  } else {
    const days = parseInt(preset, 10);
    const from = new Date(now); from.setDate(from.getDate() - days);
    start = isoDate(from); end = isoDate(now); label = `Last ${days} Days`;
  }
  dashCustomRange = { start, end, label };

  document.querySelectorAll(".preset-btn").forEach((b) => b.classList.toggle("active", b.dataset.preset === preset));
}

function clearDashPreset() {
  dashCustomRange = null;
  document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
}

function showDashboardSkeleton() {
  document.getElementById("kpiRow").innerHTML = Array(4).fill('<div class="kpi-card skeleton kpi-skeleton"></div>').join("");
  document.getElementById("statStrip").innerHTML = "";
  document.getElementById("chartGrid").innerHTML = `
    <div class="chart-row-3">
      <div class="chart-card skeleton chart-skeleton"></div>
      <div class="chart-card skeleton chart-skeleton"></div>
      <div class="chart-card skeleton chart-skeleton"></div>
    </div>
    <div class="chart-row-3">
      <div class="chart-card skeleton chart-skeleton"></div>
      <div class="chart-card skeleton chart-skeleton"></div>
      <div class="chart-card skeleton chart-skeleton"></div>
    </div>
  `;
  document.getElementById("kpiRow").style.display = "grid";
  document.getElementById("chartGrid").style.display = "flex";
  document.getElementById("emptyState").style.display = "none";
}

function chartFilterBadge(clearType, label) {
  return `<span class="chart-filter-badge" onclick="event.stopPropagation(); clearChartFilter('${clearType}')" title="Clear only this filter">${escapeHtml(label)} &times;</span>`;
}

function chartCardCls(isFiltered) {
  return isFiltered ? "chart-card chart-card-filtered" : "chart-card";
}

async function clearChartFilter(type) {
  if (type === "trend") {
    clearDashPreset();
  } else if (type === "shift") {
    DASH_MS.dashShiftFilter?.clear();
  } else if (type === "technician") {
    DASH_MS.dashTechnicianFilter?.clear();
  } else if (type === "fault") {
    DASH_MS.dashFaultFilter?.clear();
  } else if (type === "hour") {
    dashHourFilter = "";
  } else if (type === "machine") {
    DASH_MS.dashMachineFilter?.clear();
    DASH_MS.dashMachineNoFilter?.clear();
    await refreshCascadingFilterOptions();
  }
  toast("Filter cleared");
  renderDashboard();
}

function badgeLabel(arr) {
  if (!arr.length) return "";
  return arr.length === 1 ? arr[0] : `${arr.length} selected`;
}

function restoreChartGridMarkup() {
  const f = currentDashFilters();
  const trendFiltered = !!dashCustomRange;
  const shiftFiltered = !!f.shift.length;
  const techFiltered = !!f.technician.length;
  const machineFiltered = !!f.machine.length;
  const faultFiltered = !!f.fault.length;
  const hourFiltered = !!f.hour;
  const machineLabel = badgeLabel(f.machine) + (f.machine.length === 1 && f.machineNo.length ? " #" + badgeLabel(f.machineNo) : "");
  const hourLabel = String(f.hour).padStart(2, "0") + ":00";

  document.getElementById("chartGrid").innerHTML = `
    <div class="chart-row-3">
      <div class="${chartCardCls(trendFiltered)}">
        <h3><span class="ci">&#128200;</span> Downtime Trend (per day) ${trendFiltered ? chartFilterBadge("trend", dashCustomRange.label) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="trendChart"></canvas></div>
      </div>
      <div class="${chartCardCls(shiftFiltered)}">
        <h3><span class="ci">&#128337;</span> Shift Distribution ${shiftFiltered ? chartFilterBadge("shift", badgeLabel(f.shift)) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="shiftChart"></canvas></div>
      </div>
      <div class="${chartCardCls(hourFiltered)}" id="hourChartCard" style="display:none;">
        <h3><span class="ci">&#128336;</span> Downtime by Hour of Day ${hourFiltered ? chartFilterBadge("hour", hourLabel) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="hourChart"></canvas></div>
      </div>
    </div>

    <div class="chart-row-3">
      <div class="${chartCardCls(techFiltered)}">
        <h3><span class="ci">&#128119;</span> Technician Workload ${techFiltered ? chartFilterBadge("technician", badgeLabel(f.technician)) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="techChart"></canvas></div>
      </div>
      <div class="${chartCardCls(machineFiltered)}">
        <h3><span class="ci">&#128295;</span> Machine-wise Downtime (min) &mdash; All Machines ${machineFiltered ? chartFilterBadge("machine", machineLabel) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="machineChart"></canvas></div>
      </div>
      <div class="${chartCardCls(faultFiltered)}">
        <h3><span class="ci">&#9888;</span> Fault Categories &mdash; All Faults ${faultFiltered ? chartFilterBadge("fault", badgeLabel(f.fault)) : ""}</h3>
        <div class="chart-canvas-wrap"><canvas id="faultChart"></canvas></div>
      </div>
    </div>
  `;
}

function kpiDeltaHtml(current, previous, invert = true) {
  if (previous === null || previous === undefined) return "";
  if (previous === 0) {
    if (current === 0) return `<div class="kpi-delta flat">Same as previous period</div>`;
    return `<div class="kpi-delta ${invert ? "up-bad" : "up-good"}">&#9650; New (was 0 in previous period)</div>`;
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 1) return `<div class="kpi-delta flat">&#8212; Same as previous period</div>`;
  const isUp = pct > 0;
  const cls = isUp ? (invert ? "up-bad" : "up-good") : (invert ? "down-good" : "down-bad");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  return `<div class="kpi-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(0)}% vs previous period</div>`;
}

async function renderDashboard() {
  showDashboardSkeleton();
  updateDashFilterSummary();

  const f = currentDashFilters();
  const s = await fetchDashboardStats();

  let prevStats = null;
  if (f.year && !dashCustomRange) {
    const prevRange = computePreviousPeriod(f.year, f.month);
    if (prevRange.start) {
      prevStats = await fetchStatsFor(prevRange.start, prevRange.end, {
        unit: f.unit, machine: f.machine, machineNo: f.machineNo, shift: f.shift, technician: f.technician, fault: f.fault, hour: f.hour,
      });
    }
  }

  const kpiRow = document.getElementById("kpiRow");
  const chartGrid = document.getElementById("chartGrid");
  const emptyState = document.getElementById("emptyState");

  if (s.total === 0) {
    chartGrid.style.display = "none";
    kpiRow.style.display = "none";
    document.getElementById("statStrip").style.display = "none";
    document.getElementById("insightsPanel").style.display = "none";
    emptyState.style.display = "flex";
    return;
  }
  chartGrid.style.display = "flex";
  kpiRow.style.display = "grid";
  document.getElementById("statStrip").style.display = "grid";
  emptyState.style.display = "none";

  const drillUrl = buildDashDrillThroughUrl();
  kpiRow.innerHTML = `
    <div class="kpi-card clickable-kpi" onclick="location.href='${drillUrl}'" title="View full detail in Logs">
      <div class="kpi-icon">&#9888;</div><div>
      <div class="kpi-value">${s.total}</div><div class="kpi-label">Total Breakdowns</div>
      ${prevStats ? kpiDeltaHtml(s.total, prevStats.total, true) : ""}
    </div></div>
    <div class="kpi-card clickable-kpi" onclick="location.href='${drillUrl}'" title="View full detail in Logs">
      <div class="kpi-icon">&#9201;</div><div>
      <div class="kpi-value">${fmtMinutes(s.totalMinutes)}</div><div class="kpi-label">Total Downtime</div>
      ${prevStats ? kpiDeltaHtml(s.totalMinutes, prevStats.totalMinutes, true) : ""}
    </div></div>
    <div class="kpi-card"><div class="kpi-icon">&#9878;</div><div>
      <div class="kpi-value">${fmtMinutes(s.avgMinutes)}</div><div class="kpi-label">Avg Downtime / Event</div>
      ${prevStats ? kpiDeltaHtml(s.avgMinutes, prevStats.avgMinutes, true) : ""}
    </div></div>
    <div class="kpi-card clickable-kpi" onclick="drillDownMachine('${escapeHtml(s.topMachine).replace(/'/g, "\'")}')" title="Filter by this machine">
      <div class="kpi-icon">&#128295;</div><div>
      <div class="kpi-value">${escapeHtml(s.topMachine)}</div><div class="kpi-label">Most Affected Machine</div>
    </div></div>
  `;

  document.getElementById("statStrip").innerHTML = `
    <div class="stat-chip"><span class="stat-chip-label">Machines Affected</span><span class="stat-chip-value">${s.distinctMachines}</span></div>
    <div class="stat-chip"><span class="stat-chip-label">Fault Types</span><span class="stat-chip-value">${s.distinctFaults}</span></div>
    <div class="stat-chip"><span class="stat-chip-label">Technicians Involved</span><span class="stat-chip-value">${s.distinctTechnicians}</span></div>
    <div class="stat-chip"><span class="stat-chip-label">Units Reporting</span><span class="stat-chip-value">${s.distinctUnits}</span></div>
  `;

  if (typeof Chart === "undefined") {
    chartGrid.innerHTML = `<div class="chart-card"><h3>Charts could not load</h3>
      <p style="color:#b23048;font-size:13px">Check the static/chart.umd.js file.</p></div>`;
    return;
  }

  restoreChartGridMarkup();

  const pointerHover = (evt, elements) => {
    evt.native.target.style.cursor = elements.length ? "pointer" : "default";
  };

  destroyChart("trend");
  charts.trend = new Chart(document.getElementById("trendChart"), {
    type: "bar",
    data: { labels: s.trendData.map((d) => d.date), datasets: [{ label: "Downtime (min)", data: s.trendData.map((d) => d.minutes), backgroundColor: ACCENT, borderRadius: 3 }] },
    options: baseChartOptions({
      onHover: pointerHover,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const yr = document.getElementById("dashYearFilter").value;
        if (!yr) return; // ambiguous year when "All Time" is active — skip drill-down
        const idx = elements[0].index;
        const dateLabel = s.trendData[idx].date; // "MM-DD"
        const iso = `${yr}-${dateLabel}`;
        dashCustomRange = { start: iso, end: iso, label: `Day: ${dateLabel}` };
        document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
        refreshCascadingFilterOptions().then(renderDashboard);
      },
    }),
  });

  destroyChart("machine");
  charts.machine = new Chart(document.getElementById("machineChart"), {
    type: "bar",
    data: { labels: s.machineData.map((d) => d.name), datasets: [{ label: "Minutes", data: s.machineData.map((d) => d.minutes), backgroundColor: ACCENT, borderRadius: 4 }] },
    options: baseChartOptions({
      indexAxis: "y",
      onHover: pointerHover,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const label = s.machineData[elements[0].index].name;
        drillDownMachine(label);
      },
    }),
  });

  destroyChart("fault");
  charts.fault = new Chart(document.getElementById("faultChart"), {
    type: "bar",
    data: { labels: s.faultData.map((d) => d.name), datasets: [{ label: "Count", data: s.faultData.map((d) => d.count), backgroundColor: "#17998f", borderRadius: 4 }] },
    options: baseChartOptions({
      indexAxis: "y",
      onHover: pointerHover,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        drillDownFilter("dashFaultFilter", s.faultData[elements[0].index].name, false);
      },
      scales: { x: { beginAtZero: true, ticks: { color: "#64748b", precision: 0 }, grid: { color: "#e6ebf1" } }, y: { ticks: { color: "#64748b", font: { size: 11 } }, grid: { display: false } } },
    }),
  });

  destroyChart("shift");
  charts.shift = new Chart(document.getElementById("shiftChart"), {
    type: "pie",
    data: { labels: s.shiftData.map((d) => d.name), datasets: [{ data: s.shiftData.map((d) => d.count), backgroundColor: PALETTE }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: "#45586b", font: { size: 11 } } } },
      onHover: pointerHover,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        drillDownFilter("dashShiftFilter", s.shiftData[elements[0].index].name, false);
      },
    },
  });

  destroyChart("tech");
  charts.tech = new Chart(document.getElementById("techChart"), {
    type: "bar",
    data: { labels: s.techData.map((d) => d.name), datasets: [{ label: "Jobs", data: s.techData.map((d) => d.count), backgroundColor: "#d1495b", borderRadius: 4 }] },
    options: baseChartOptions({
      indexAxis: "y",
      onHover: pointerHover,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        drillDownFilter("dashTechnicianFilter", s.techData[elements[0].index].name, false);
      },
      scales: { x: { ticks: { color: "#64748b", precision: 0 }, grid: { color: "#e6ebf1" } }, y: { ticks: { color: "#64748b", font: { size: 11 } }, grid: { display: false } } },
    }),
  });

  renderInsights(s, prevStats);
  renderHourChart(s.hourData);
}

function renderHourChart(hourData) {
  const card = document.getElementById("hourChartCard");
  if (!hourData || !hourData.some((h) => h.minutes > 0)) { card.style.display = "none"; return; }
  card.style.display = "";

  destroyChart("hour");
  charts.hour = new Chart(document.getElementById("hourChart"), {
    type: "bar",
    data: {
      labels: hourData.map((h) => `${String(h.hour).padStart(2, "0")}:00`),
      datasets: [{ label: "Downtime (min)", data: hourData.map((h) => h.minutes), backgroundColor: "#7048c0", borderRadius: 3 }],
    },
    options: baseChartOptions({
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        dashHourFilter = String(hourData[elements[0].index].hour);
        toast(`Filter applied: ${String(hourData[elements[0].index].hour).padStart(2, "0")}:00`);
        renderDashboard();
      },
      scales: { x: { ticks: { color: "#64748b", font: { size: 9 }, maxRotation: 90, minRotation: 90 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#64748b" }, grid: { color: "#e6ebf1" } } },
    }),
  });
}

function renderInsights(s, prevStats) {
  const panel = document.getElementById("insightsPanel");
  const list = document.getElementById("insightsList");
  if (!s.total) { panel.style.display = "none"; return; }

  const insights = [];

  if (s.machineData.length) {
    const top = s.machineData[0];
    const share = s.totalMinutes ? Math.round((top.minutes / s.totalMinutes) * 100) : 0;
    insights.push(`<strong>${escapeHtml(top.name)}</strong> accounts for <strong>${share}%</strong> of total downtime (${fmtMinutes(top.minutes)}) this period.`);
  }

  if (prevStats && prevStats.totalMinutes !== undefined) {
    if (prevStats.totalMinutes === 0 && s.totalMinutes > 0) {
      insights.push(`Total downtime is <strong>new this period</strong> — there was no breakdown record in the previous period.`);
    } else if (prevStats.totalMinutes > 0) {
      const pct = Math.round(((s.totalMinutes - prevStats.totalMinutes) / prevStats.totalMinutes) * 100);
      if (Math.abs(pct) >= 1) {
        const dir = pct > 0 ? "increased" : "decreased";
        insights.push(`Total downtime has <strong>${dir} by ${Math.abs(pct)}%</strong> compared to the previous period.`);
      }
    }
  }

  if (s.faultData.length) {
    const topF = s.faultData[0];
    insights.push(`<strong>${escapeHtml(topF.name)}</strong> is the most frequent fault type, recorded <strong>${topF.count}</strong> time(s).`);
  }

  if (s.topShift && s.topShift !== "—") {
    insights.push(`Shift <strong>${escapeHtml(s.topShift)}</strong> recorded the highest number of breakdowns.`);
  }

  if (!insights.length) { panel.style.display = "none"; return; }
  list.innerHTML = insights.slice(0, 4).map((t) => `<li>${t}</li>`).join("");
  panel.style.display = "block";
}

function populateYearSelect(selectEl, spanBack = 3, spanForward = 1) {
  const nowYear = new Date().getFullYear();
  let html = `<option value="">All Years</option>`;
  for (let y = nowYear + spanForward; y >= nowYear - spanBack; y--) {
    html += `<option value="${y}" ${y === nowYear ? "selected" : ""}>${y}</option>`;
  }
  selectEl.innerHTML = html;
}

async function refreshMachineNoOptions() {
  const f = currentDashFilters();
  const ms = DASH_MS.dashMachineNoFilter;
  if (!ms) return;

  if (!f.machine.length) {
    ms.setOptions([], false);
    return;
  }

  const params = new URLSearchParams();
  f.machine.forEach((v) => params.append("machine", v));
  f.unit.forEach((v) => params.append("unit", v));
  const numbers = await fetch("/api/machine-numbers?" + params.toString()).then((r) => r.json()).catch(() => []);
  ms.setOptions(numbers, true);
}

async function refreshCascadingFilterOptions() {
  await refreshMachineNoOptions();
  const f = currentDashFilters();
  const { start, end } = dashActiveDateRange();
  const s = await fetchStatsFor(start, end, { unit: f.unit, machine: f.machine, machineNo: f.machineNo, hour: f.hour });

  DASH_MS.dashShiftFilter?.setOptions(s.shiftData.map((d) => d.name), true);
  DASH_MS.dashTechnicianFilter?.setOptions(s.techData.map((d) => d.name), true);
  DASH_MS.dashFaultFilter?.setOptions(s.faultData.map((d) => d.name), true);
}

async function initDashboardPage() {
  populateYearSelect(document.getElementById("dashYearFilter"));
  const now = new Date();
  document.getElementById("dashMonthFilter").value = String(now.getMonth() + 1);

  DASH_MS.dashUnitFilter = new MultiSelect(document.getElementById("dashUnitFilter"), {
    placeholder: "All",
    onChange: async () => {
      const scopedRef = await loadReference(true, DASH_MS.dashUnitFilter.getValues());
      DASH_MS.dashMachineFilter.setOptions(scopedRef.machines, true);
      await refreshCascadingFilterOptions();
      renderDashboard();
    },
  });
  DASH_MS.dashMachineFilter = new MultiSelect(document.getElementById("dashMachineFilter"), {
    placeholder: "All",
    onChange: async () => { clearDashPreset(); await refreshCascadingFilterOptions(); renderDashboard(); },
  });
  DASH_MS.dashMachineNoFilter = new MultiSelect(document.getElementById("dashMachineNoFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });
  DASH_MS.dashShiftFilter = new MultiSelect(document.getElementById("dashShiftFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });
  DASH_MS.dashTechnicianFilter = new MultiSelect(document.getElementById("dashTechnicianFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });
  DASH_MS.dashFaultFilter = new MultiSelect(document.getElementById("dashFaultFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });
  DASH_MS.dashComplaintFilter = new MultiSelect(document.getElementById("dashComplaintFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });
  DASH_MS.dashNotificationFilter = new MultiSelect(document.getElementById("dashNotificationFilter"), {
    placeholder: "All",
    onChange: () => renderDashboard(),
  });

  const units = await loadUnits();
  DASH_MS.dashUnitFilter.setOptions(units.map((u) => u.name), false);
  const ref = await loadReference();
  DASH_MS.dashMachineFilter.setOptions(ref.machines, false);
  DASH_MS.dashShiftFilter.setOptions(ref.shifts, false);
  DASH_MS.dashTechnicianFilter.setOptions(ref.technicians, false);
  DASH_MS.dashFaultFilter.setOptions(ref.faultCategories, false);
  DASH_MS.dashComplaintFilter.setOptions(ref.complaintReferences || [], false);
  DASH_MS.dashNotificationFilter.setOptions(ref.notificationTypes || [], false);
  await refreshCascadingFilterOptions();

  ["dashYearFilter", "dashMonthFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("change", async () => {
      clearDashPreset();
      await refreshCascadingFilterOptions();
      renderDashboard();
    });
  });
  document.getElementById("dashAllTimeBtn").addEventListener("click", async () => {
    clearDashPreset();
    document.getElementById("dashYearFilter").value = "";
    document.getElementById("dashMonthFilter").value = "";
    await refreshCascadingFilterOptions();
    renderDashboard();
  });
  document.getElementById("dashClearFiltersBtn").addEventListener("click", async () => {
    DASH_MS.dashUnitFilter.clear();
    DASH_MS.dashMachineFilter.clear();
    DASH_MS.dashMachineNoFilter.clear();
    DASH_MS.dashShiftFilter.clear();
    DASH_MS.dashTechnicianFilter.clear();
    DASH_MS.dashFaultFilter.clear();
    DASH_MS.dashComplaintFilter.clear();
    DASH_MS.dashNotificationFilter.clear();
    dashHourFilter = "";
    await refreshCascadingFilterOptions();
    renderDashboard();
  });
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      applyDashPreset(btn.dataset.preset);
      await refreshCascadingFilterOptions();
      renderDashboard();
    });
  });
  document.getElementById("dashRefreshBtn").addEventListener("click", renderDashboard);
  document.getElementById("dashPrintBtn").addEventListener("click", () => window.print());

  let autoRefreshTimer = null;
  document.getElementById("dashAutoRefreshToggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      autoRefreshTimer = setInterval(renderDashboard, 60000);
    } else if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  });

  renderDashboard();
}

/* expose for other pages that might trigger a dashboard refresh */
async function loadDashboard() {
  if (document.getElementById("dashboardRoot")) await renderDashboard();
}

/* ============================================================
   Logs page (KPI cards + multi-filter)
   ============================================================ */

let logDebounce = null;

let LOGS_MS = {};

function buildLogParams() {
  const params = new URLSearchParams();
  const q = document.getElementById("searchInput").value.trim();
  const start = document.getElementById("logStart").value;
  const end = document.getElementById("logEnd").value;
  if (q) params.set("q", q);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  (LOGS_MS.unitFilter?.getValues() || []).forEach((v) => params.append("unit", v));
  (LOGS_MS.machineFilter?.getValues() || []).forEach((v) => params.append("machine", v));
  (LOGS_MS.shiftFilter?.getValues() || []).forEach((v) => params.append("shift", v));
  (LOGS_MS.technicianFilter?.getValues() || []).forEach((v) => params.append("technician", v));
  (LOGS_MS.faultFilter?.getValues() || []).forEach((v) => params.append("fault", v));
  (LOGS_MS.complaintFilter?.getValues() || []).forEach((v) => params.append("complaintReference", v));
  (LOGS_MS.notificationFilter?.getValues() || []).forEach((v) => params.append("notificationType", v));
  return params;
}

async function refreshLogsKpis(params) {
  const res = await fetch("/api/stats?" + params.toString());
  const s = await res.json();
  const row = document.getElementById("logsKpiRow");
  if (!row) return;
  row.innerHTML = `
    <div class="kpi-card"><div class="kpi-icon">&#9888;</div><div><div class="kpi-value">${s.total}</div><div class="kpi-label">Filtered Records</div></div></div>
    <div class="kpi-card"><div class="kpi-icon">&#9201;</div><div><div class="kpi-value">${fmtMinutes(s.totalMinutes)}</div><div class="kpi-label">Total Downtime</div></div></div>
    <div class="kpi-card"><div class="kpi-icon">&#9878;</div><div><div class="kpi-value">${fmtMinutes(s.avgMinutes)}</div><div class="kpi-label">Avg Downtime / Event</div></div></div>
    <div class="kpi-card"><div class="kpi-icon">&#128295;</div><div><div class="kpi-value">${escapeHtml(s.topMachine)}</div><div class="kpi-label">Most Affected Machine</div></div></div>
  `;
}

let LOG_ROWS_CACHE = {};
let CURRENT_USER_PERMS = { can_add_data: false, can_edit_delete: false };
let LOG_ALL_ROWS = [];
let logSortField = "date";
let logSortDir = "desc"; // rows already come sorted desc by date from the API by default
let logCurrentPage = 1;
const LOG_PAGE_SIZE = 25;

function sortLogRows(rows) {
  const dir = logSortDir === "asc" ? 1 : -1;
  const field = logSortField;
  return [...rows].sort((a, b) => {
    let av = a[field] || "", bv = b[field] || "";
    if (field === "downtime") { av = downtimeToMinutesJS(av); bv = downtimeToMinutesJS(bv); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function downtimeToMinutesJS(dt) {
  if (!dt) return 0;
  const parts = dt.split(":").map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 60 + parts[1];
}

async function refreshLogTable() {
  const params = buildLogParams();
  document.getElementById("logsExportBtn").href = "/api/reports/export?" + params.toString();

  const res = await fetch("/api/records?" + params.toString());
  LOG_ALL_ROWS = await res.json();
  refreshLogsKpis(params);
  logCurrentPage = 1;
  renderLogTablePage();
}

function renderLogTablePage() {
  const sorted = sortLogRows(LOG_ALL_ROWS);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  if (logCurrentPage > totalPages) logCurrentPage = totalPages;
  const startIdx = (logCurrentPage - 1) * LOG_PAGE_SIZE;
  const pageRows = sorted.slice(startIdx, startIdx + LOG_PAGE_SIZE);

  LOG_ROWS_CACHE = {};
  LOG_ALL_ROWS.forEach((r) => { LOG_ROWS_CACHE[r.id] = r; });

  document.getElementById("logCount").textContent = `${total} records`;
  const tbody = document.getElementById("logTableBody");

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("active", th.dataset.sort === logSortField);
    const arrow = th.querySelector(".sort-arrow");
    arrow.textContent = th.dataset.sort === logSortField ? (logSortDir === "asc" ? "▲" : "▼") : "";
  });

  if (total === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="no-rows">No records found.</td></tr>`;
    document.getElementById("paginationBar").innerHTML = "";
    return;
  }

  const canEdit = CURRENT_USER_PERMS.can_edit_delete;

  tbody.innerHTML = pageRows.map((r) => `
    <tr>
      <td class="mono">${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.unit)}</td>
      <td>${escapeHtml(r.machine)}${r.machineNo ? " #" + escapeHtml(r.machineNo) : ""}</td>
      <td><span class="pill">${escapeHtml(r.faultCategory)}</span></td>
      <td class="mono">${escapeHtml(r.shift)}</td>
      <td>${escapeHtml(r.technician)}</td>
      <td class="mono downtime-cell">${escapeHtml(r.downtime)}</td>
      <td>
        <button class="icon-btn view-btn" onclick="showRecordDetail('${r.id}')" title="View full detail">&#128065;</button>
        ${canEdit ? `<button class="icon-btn view-btn" onclick="openEditModal('${r.id}')" title="Edit">&#9998;</button>` : ""}
        ${canEdit ? `<button class="icon-btn danger" onclick="deleteRecord('${r.id}')" title="Delete">&#128465;</button>` : ""}
      </td>
    </tr>
  `).join("");

  renderPaginationBar(total, totalPages);
}

function renderPaginationBar(total, totalPages) {
  const bar = document.getElementById("paginationBar");
  if (totalPages <= 1) { bar.innerHTML = ""; return; }

  const startShown = (logCurrentPage - 1) * LOG_PAGE_SIZE + 1;
  const endShown = Math.min(logCurrentPage * LOG_PAGE_SIZE, total);

  let pageBtns = "";
  const maxBtns = 5;
  let from = Math.max(1, logCurrentPage - Math.floor(maxBtns / 2));
  let to = Math.min(totalPages, from + maxBtns - 1);
  from = Math.max(1, to - maxBtns + 1);
  for (let p = from; p <= to; p++) {
    pageBtns += `<button class="page-btn ${p === logCurrentPage ? "active" : ""}" onclick="goToLogPage(${p})">${p}</button>`;
  }

  bar.innerHTML = `
    <div class="pagination-info">Showing ${startShown}–${endShown} of ${total}</div>
    <div class="pagination-controls">
      <button class="page-btn" onclick="goToLogPage(1)" ${logCurrentPage === 1 ? "disabled" : ""} title="First">&#171;</button>
      <button class="page-btn" onclick="goToLogPage(${logCurrentPage - 1})" ${logCurrentPage === 1 ? "disabled" : ""} title="Previous">&#8249;</button>
      ${pageBtns}
      <button class="page-btn" onclick="goToLogPage(${logCurrentPage + 1})" ${logCurrentPage === totalPages ? "disabled" : ""} title="Next">&#8250;</button>
      <button class="page-btn" onclick="goToLogPage(${totalPages})" ${logCurrentPage === totalPages ? "disabled" : ""} title="Last">&#187;</button>
    </div>
  `;
}

function goToLogPage(p) {
  logCurrentPage = p;
  renderLogTablePage();
  document.getElementById("logTableBody").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setLogSort(field) {
  if (logSortField === field) {
    logSortDir = logSortDir === "asc" ? "desc" : "asc";
  } else {
    logSortField = field;
    logSortDir = "asc";
  }
  logCurrentPage = 1;
  renderLogTablePage();
}

function detailField(label, value, mono = false) {
  const v = (value || "").toString().trim();
  const cls = "detail-item-value" + (mono ? " mono" : "") + (v ? "" : " empty");
  return `<div><div class="detail-item-label">${label}</div><div class="${cls}">${escapeHtml(v) || "—"}</div></div>`;
}

function showRecordDetail(id) {
  const r = LOG_ROWS_CACHE[id];
  if (!r) return;
  const grid = document.getElementById("detailGrid");
  grid.innerHTML = [
    detailField("Date", r.date, true),
    detailField("Unit", r.unit),
    detailField("Complaint Reference", r.complaintReference),
    detailField("Notification Type", r.notificationType),
    detailField("Ticket No.", r.ticketNo, true),
    detailField("Order No.", r.orderNo, true),
    detailField("Machine", r.machine),
    detailField("Machine No.", r.machineNo, true),
    detailField("Device Detail", r.deviceDetail),
    detailField("Device Sub-Category", r.deviceSubCat),
    detailField("Fault Category", r.faultCategory),
    detailField("Shift", r.shift, true),
    detailField("Technician", r.technician),
    detailField("Downtime", r.downtime, true),
    detailField("Time Start", r.timeStart, true),
    detailField("Time Finish", r.timeFinish, true),
    `<div class="full">${detailField("Reason / RCA", r.reason)}</div>`,
    `<div class="full">${detailField("Action Taken", r.actionTaken)}</div>`,
    `<div class="full">${detailField("Remarks", r.remarks)}</div>`,
  ].join("");
  document.getElementById("detailModalBackdrop").classList.add("open");
}

async function openEditModal(id) {
  const r = LOG_ROWS_CACHE[id];
  if (!r) return;

  const unit = r.unit;
  const [units, scopedRef] = await Promise.all([loadUnits(), loadReference(true, unit)]);
  fillSelect(document.getElementById("e_unit"), units.map((u) => u.name), false);
  fillSelect(document.getElementById("e_machine"), scopedRef.machines, false);
  fillSelect(document.getElementById("e_shift"), scopedRef.shifts, false);
  fillSelect(document.getElementById("e_faultCategory"), scopedRef.faultCategories, false);
  if (EDIT_TECH_MS) EDIT_TECH_MS.setOptions(scopedRef.technicians, false);
  fillSelect(document.getElementById("e_complaintReference"), scopedRef.complaintReferences || []);
  fillSelect(document.getElementById("e_notificationType"), scopedRef.notificationTypes || []);
  fillSelect(document.getElementById("e_deviceDetail"), scopedRef.deviceDetails || []);
  fillSelect(document.getElementById("e_deviceSubCat"), scopedRef.deviceSubCategories || []);

  document.getElementById("e_id").value = r.id;
  document.getElementById("e_unit").value = r.unit;
  document.getElementById("e_date").value = r.date;
  document.getElementById("e_shift").value = r.shift;
  document.getElementById("e_complaintReference").value = r.complaintReference || "";
  document.getElementById("e_notificationType").value = r.notificationType || "";
  document.getElementById("e_ticketNo").value = r.ticketNo || "";
  document.getElementById("e_orderNo").value = r.orderNo || "";
  document.getElementById("e_machine").value = r.machine;
  document.getElementById("e_machineNo").value = r.machineNo || "";
  document.getElementById("e_deviceDetail").value = r.deviceDetail || "";
  document.getElementById("e_deviceSubCat").value = r.deviceSubCat || "";
  document.getElementById("e_faultCategory").value = r.faultCategory;
  if (EDIT_TECH_MS) EDIT_TECH_MS.setValues((r.technician || "").split(",").map((s) => s.trim()).filter(Boolean));
  document.getElementById("e_timeStart").value = r.timeStart;
  document.getElementById("e_timeFinish").value = r.timeFinish;
  document.getElementById("e_reason").value = r.reason || "";
  document.getElementById("e_actionTaken").value = r.actionTaken || "";
  document.getElementById("e_remarks").value = r.remarks || "";
  document.getElementById("editDowntimePreview").textContent = r.downtime || "--:--";
  document.getElementById("editFormError").classList.remove("show");

  document.getElementById("editModalBackdrop").classList.add("open");
}

async function deleteRecord(id) {
  if (!(await showConfirm("Are you sure you want to delete this record?"))) return;
  await fetch(`/api/records/${id}`, { method: "DELETE" });
  toast("Record deleted");
  refreshLogTable();
}

let EDIT_TECH_MS = null;

async function initLogPage() {
  const me = await fetch("/api/me").then((r) => r.json()).catch(() => ({}));
  CURRENT_USER_PERMS = { can_add_data: !!me.can_add_data, can_edit_delete: !!me.can_edit_delete };

  LOGS_MS.unitFilter = new MultiSelect(document.getElementById("unitFilter"), { placeholder: "All Units", onChange: refreshLogTable });
  LOGS_MS.machineFilter = new MultiSelect(document.getElementById("machineFilter"), { placeholder: "All Machines", onChange: refreshLogTable });
  LOGS_MS.shiftFilter = new MultiSelect(document.getElementById("shiftFilter"), { placeholder: "All Shifts", onChange: refreshLogTable });
  LOGS_MS.technicianFilter = new MultiSelect(document.getElementById("technicianFilter"), { placeholder: "All Technicians", onChange: refreshLogTable });
  LOGS_MS.faultFilter = new MultiSelect(document.getElementById("faultFilter"), { placeholder: "All Faults", onChange: refreshLogTable });
  LOGS_MS.complaintFilter = new MultiSelect(document.getElementById("complaintFilter"), { placeholder: "All Complaint Refs", onChange: refreshLogTable });
  LOGS_MS.notificationFilter = new MultiSelect(document.getElementById("notificationFilter"), { placeholder: "All", onChange: refreshLogTable });
  EDIT_TECH_MS = new MultiSelect(document.getElementById("e_technician"), { placeholder: "Select technician(s)" });

  const units = await loadUnits();
  LOGS_MS.unitFilter.setOptions(units.map((u) => u.name), false);

  const ref = await loadReference();
  LOGS_MS.machineFilter.setOptions(ref.machines, false);
  LOGS_MS.shiftFilter.setOptions(ref.shifts, false);
  LOGS_MS.technicianFilter.setOptions(ref.technicians, false);
  LOGS_MS.faultFilter.setOptions(ref.faultCategories, false);
  LOGS_MS.complaintFilter.setOptions(ref.complaintReferences || [], false);
  LOGS_MS.notificationFilter.setOptions(ref.notificationTypes || [], false);

  const backdrop = document.getElementById("detailModalBackdrop");
  document.getElementById("closeDetailBtn").addEventListener("click", () => backdrop.classList.remove("open"));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.remove("open"); });

  const editBackdrop = document.getElementById("editModalBackdrop");
  const closeEdit = () => editBackdrop.classList.remove("open");
  document.getElementById("closeEditBtn").addEventListener("click", closeEdit);
  document.getElementById("cancelEditBtn").addEventListener("click", closeEdit);
  editBackdrop.addEventListener("click", (e) => { if (e.target === editBackdrop) closeEdit(); });

  document.getElementById("e_unit").addEventListener("change", async (e) => {
    const scoped = await loadReference(true, e.target.value);
    fillSelect(document.getElementById("e_machine"), scoped.machines, false);
  });

  function updateEditDowntime() {
    const s = document.getElementById("e_timeStart").value;
    const f = document.getElementById("e_timeFinish").value;
    document.getElementById("editDowntimePreview").textContent = computeDowntimeStr(s, f) || "--:--";
  }
  document.getElementById("e_timeStart").addEventListener("input", updateEditDowntime);
  document.getElementById("e_timeFinish").addEventListener("input", updateEditDowntime);

  document.getElementById("editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("e_id").value;
    const errBox = document.getElementById("editFormError");
    errBox.classList.remove("show");

    const payload = {
      unit: document.getElementById("e_unit").value,
      date: document.getElementById("e_date").value,
      shift: document.getElementById("e_shift").value,
      complaintReference: document.getElementById("e_complaintReference").value,
      notificationType: document.getElementById("e_notificationType").value,
      ticketNo: document.getElementById("e_ticketNo").value,
      orderNo: document.getElementById("e_orderNo").value,
      machine: document.getElementById("e_machine").value,
      machineNo: document.getElementById("e_machineNo").value,
      deviceDetail: document.getElementById("e_deviceDetail").value,
      deviceSubCat: document.getElementById("e_deviceSubCat").value,
      faultCategory: document.getElementById("e_faultCategory").value,
      technician: EDIT_TECH_MS ? EDIT_TECH_MS.getValues() : [],
      timeStart: document.getElementById("e_timeStart").value,
      timeFinish: document.getElementById("e_timeFinish").value,
      reason: document.getElementById("e_reason").value,
      actionTaken: document.getElementById("e_actionTaken").value,
      remarks: document.getElementById("e_remarks").value,
    };

    const res = await fetch(`/api/records/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errBox.textContent = err.error || "Something went wrong.";
      errBox.classList.add("show");
      return;
    }
    toast("Record updated");
    closeEdit();
    refreshLogTable();
  });

  document.getElementById("searchInput").addEventListener("input", () => {
    clearTimeout(logDebounce);
    logDebounce = setTimeout(refreshLogTable, 250);
  });
  ["logStart", "logEnd"].forEach((id) => {
    document.getElementById(id).addEventListener("change", refreshLogTable);
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    document.getElementById("searchInput").value = "";
    document.getElementById("logStart").value = "";
    document.getElementById("logEnd").value = "";
    LOGS_MS.unitFilter.clear();
    LOGS_MS.machineFilter.clear();
    LOGS_MS.shiftFilter.clear();
    LOGS_MS.technicianFilter.clear();
    LOGS_MS.faultFilter.clear();
    LOGS_MS.complaintFilter.clear();
    LOGS_MS.notificationFilter.clear();
    refreshLogTable();
  });

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => setLogSort(th.dataset.sort));
  });

  // pre-fill filters if arriving via a dashboard drill-through link
  // (getAll() supports repeated params, e.g. ?unit=A&unit=B, from multi-select filters)
  const qp = new URLSearchParams(window.location.search);
  if (qp.toString()) {
    if (qp.get("start")) document.getElementById("logStart").value = qp.get("start");
    if (qp.get("end")) document.getElementById("logEnd").value = qp.get("end");
    if (qp.getAll("unit").length) LOGS_MS.unitFilter.setValues(qp.getAll("unit"));
    if (qp.getAll("machine").length) LOGS_MS.machineFilter.setValues(qp.getAll("machine"));
    if (qp.getAll("shift").length) LOGS_MS.shiftFilter.setValues(qp.getAll("shift"));
    if (qp.getAll("technician").length) LOGS_MS.technicianFilter.setValues(qp.getAll("technician"));
    if (qp.getAll("fault").length) LOGS_MS.faultFilter.setValues(qp.getAll("fault"));
    if (qp.getAll("complaintReference").length) LOGS_MS.complaintFilter.setValues(qp.getAll("complaintReference"));
    if (qp.getAll("notificationType").length) LOGS_MS.notificationFilter.setValues(qp.getAll("notificationType"));
  }

  refreshLogTable();
}

/* ============================================================
   Reports page (filters only -> Excel export; no on-screen data)
   ============================================================ */

let REPORT_MS = {};
let PERF_REPORT_MS = {};

function initReportTabs() {
  const tabs = document.querySelectorAll(".settings-tab[data-report-tab]");
  if (!tabs.length) return;
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.reportTab;
      document.querySelectorAll(".report-tab-panel").forEach((panel) => {
        panel.style.display = panel.dataset.reportPanel === target ? "" : "none";
      });
    });
  });
}

function buildPerfReportParams() {
  const params = new URLSearchParams();
  const start = document.getElementById("perfReportStart").value;
  const end = document.getElementById("perfReportEnd").value;
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  (PERF_REPORT_MS.unit?.getValues() || []).forEach((v) => params.append("unit", v));
  (PERF_REPORT_MS.technician?.getValues() || []).forEach((v) => params.append("technician", v));
  return params;
}

async function updatePerfReportMatchCount() {
  const params = buildPerfReportParams();
  document.getElementById("exportPerfXlsxBtn").href = "/api/reports/performance-export?" + params.toString();
  const techs = PERF_REPORT_MS.technician?.getValues() || [];
  const statParams = new URLSearchParams(params);
  statParams.delete("technician");
  techs.forEach((t) => statParams.append("technician", t));
  const res = await fetch("/api/stats?" + statParams.toString());
  const s = await res.json();
  const scope = techs.length ? `${techs.length} technician(s)` : "all technicians";
  document.getElementById("perfReportMatchCount").textContent =
    `${s.total} record(s) match · ${scope} · total downtime ${fmtMinutes(s.totalMinutes)}`;
}

async function initPerfReportTab() {
  const unitEl = document.getElementById("perfReportUnit");
  const techEl = document.getElementById("perfReportTechnician");
  if (!unitEl || !techEl) return;

  PERF_REPORT_MS.unit = new MultiSelect(unitEl, { placeholder: "All Units", onChange: updatePerfReportMatchCount });
  PERF_REPORT_MS.technician = new MultiSelect(techEl, { placeholder: "All technicians", onChange: updatePerfReportMatchCount });

  const units = await loadUnits();
  PERF_REPORT_MS.unit.setOptions(units.map((u) => u.name), false);
  const ref = await loadReference();
  PERF_REPORT_MS.technician.setOptions(ref.technicians, false);

  ["perfReportStart", "perfReportEnd"].forEach((id) => {
    document.getElementById(id).addEventListener("change", updatePerfReportMatchCount);
  });

  updatePerfReportMatchCount();
}

function buildReportParams() {
  const params = new URLSearchParams();
  const start = document.getElementById("reportStart").value;
  const end = document.getElementById("reportEnd").value;
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  (REPORT_MS.reportUnit?.getValues() || []).forEach((v) => params.append("unit", v));
  (REPORT_MS.reportMachine?.getValues() || []).forEach((v) => params.append("machine", v));
  (REPORT_MS.reportShift?.getValues() || []).forEach((v) => params.append("shift", v));
  (REPORT_MS.reportTechnician?.getValues() || []).forEach((v) => params.append("technician", v));
  (REPORT_MS.reportFault?.getValues() || []).forEach((v) => params.append("fault", v));
  (REPORT_MS.reportComplaint?.getValues() || []).forEach((v) => params.append("complaintReference", v));
  (REPORT_MS.reportNotification?.getValues() || []).forEach((v) => params.append("notificationType", v));
  return params;
}

async function updateReportMatchCount() {
  const params = buildReportParams();
  document.getElementById("exportXlsxBtn").href = "/api/reports/export?" + params.toString();
  const res = await fetch("/api/stats?" + params.toString());
  const s = await res.json();
  document.getElementById("reportMatchCount").textContent =
    `${s.total} record(s) match the current filters · total downtime ${fmtMinutes(s.totalMinutes)}`;
}

const REPORT_PRESETS_KEY = "breakdownTracker.reportPresets";

function getReportPresets() {
  try { return JSON.parse(localStorage.getItem(REPORT_PRESETS_KEY) || "[]"); }
  catch { return []; }
}

function saveReportPresets(list) {
  localStorage.setItem(REPORT_PRESETS_KEY, JSON.stringify(list));
}

function renderPresetsList() {
  const presets = getReportPresets();
  const card = document.getElementById("presetsCard");
  const list = document.getElementById("presetsList");
  if (!presets.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  list.innerHTML = presets.map((p, i) => `
    <span class="chip" style="cursor:pointer;" onclick="loadReportPreset(${i})" title="Click to load">
      &#128278; ${escapeHtml(p.name)}
      <button onclick="event.stopPropagation(); deleteReportPreset(${i})" title="Delete">&times;</button>
    </span>
  `).join("");
}

function presetAsList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function loadReportPreset(i) {
  const p = getReportPresets()[i];
  if (!p) return;
  REPORT_MS.reportUnit.setValues(presetAsList(p.unit));
  REPORT_MS.reportMachine.setValues(presetAsList(p.machine));
  document.getElementById("reportStart").value = p.start || "";
  document.getElementById("reportEnd").value = p.end || "";
  REPORT_MS.reportShift.setValues(presetAsList(p.shift));
  REPORT_MS.reportTechnician.setValues(presetAsList(p.technician));
  REPORT_MS.reportFault.setValues(presetAsList(p.fault));
  REPORT_MS.reportComplaint.setValues(presetAsList(p.complaintReference));
  REPORT_MS.reportNotification.setValues(presetAsList(p.notificationType));
  toast(`Preset "${p.name}" loaded`);
  updateReportMatchCount();
}

function deleteReportPreset(i) {
  const presets = getReportPresets();
  presets.splice(i, 1);
  saveReportPresets(presets);
  renderPresetsList();
}

async function initReportsPage() {
  REPORT_MS.reportUnit = new MultiSelect(document.getElementById("reportUnit"), {
    placeholder: "All Units",
    onChange: async () => {
      const scoped = await loadReference(true, REPORT_MS.reportUnit.getValues());
      REPORT_MS.reportMachine.setOptions(scoped.machines, true);
      updateReportMatchCount();
    },
  });
  REPORT_MS.reportMachine = new MultiSelect(document.getElementById("reportMachine"), { placeholder: "All Machines", onChange: updateReportMatchCount });
  REPORT_MS.reportShift = new MultiSelect(document.getElementById("reportShift"), { placeholder: "All Shifts", onChange: updateReportMatchCount });
  REPORT_MS.reportTechnician = new MultiSelect(document.getElementById("reportTechnician"), { placeholder: "All Technicians", onChange: updateReportMatchCount });
  REPORT_MS.reportFault = new MultiSelect(document.getElementById("reportFault"), { placeholder: "All Faults", onChange: updateReportMatchCount });
  REPORT_MS.reportComplaint = new MultiSelect(document.getElementById("reportComplaint"), { placeholder: "All Complaint Refs", onChange: updateReportMatchCount });
  REPORT_MS.reportNotification = new MultiSelect(document.getElementById("reportNotification"), { placeholder: "All Notification Types", onChange: updateReportMatchCount });

  const units = await loadUnits();
  REPORT_MS.reportUnit.setOptions(units.map((u) => u.name), false);

  const ref = await loadReference();
  REPORT_MS.reportMachine.setOptions(ref.machines, false);
  REPORT_MS.reportShift.setOptions(ref.shifts, false);
  REPORT_MS.reportTechnician.setOptions(ref.technicians, false);
  REPORT_MS.reportFault.setOptions(ref.faultCategories, false);
  REPORT_MS.reportComplaint.setOptions(ref.complaintReferences || [], false);
  REPORT_MS.reportNotification.setOptions(ref.notificationTypes || [], false);

  ["reportStart", "reportEnd"].forEach((id) => {
    document.getElementById(id).addEventListener("change", updateReportMatchCount);
  });

  document.getElementById("savePresetBtn").addEventListener("click", () => {
    const name = prompt("Enter a name for this filter preset:");
    if (!name || !name.trim()) return;
    const presets = getReportPresets();
    presets.push({
      name: name.trim(),
      unit: REPORT_MS.reportUnit.getValues(),
      machine: REPORT_MS.reportMachine.getValues(),
      start: document.getElementById("reportStart").value,
      end: document.getElementById("reportEnd").value,
      shift: REPORT_MS.reportShift.getValues(),
      technician: REPORT_MS.reportTechnician.getValues(),
      fault: REPORT_MS.reportFault.getValues(),
      complaintReference: REPORT_MS.reportComplaint.getValues(),
      notificationType: REPORT_MS.reportNotification.getValues(),
    });
    saveReportPresets(presets);
    renderPresetsList();
    toast("Preset saved");
  });

  renderPresetsList();
  updateReportMatchCount();
}

/* ============================================================
   Users page (admin only)
   ============================================================ */

let USERS_CACHE = {};

async function refreshUsersTable() {
  const res = await fetch("/api/users");
  const users = await res.json();
  USERS_CACHE = {};
  users.forEach((u) => { USERS_CACHE[u.id] = u; });

  document.getElementById("userCount").textContent = `${users.length} users`;
  document.getElementById("usersTableBody").innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td><span class="role-pill ${u.role}">${escapeHtml(u.role)}</span></td>
      <td>
        <label style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" ${u.can_add_data ? "checked" : ""} ${u.role === "admin" ? "disabled" : ""}
                 onchange="updateUserPermission('${u.id}','can_add_data',this.checked)">
        </label>
      </td>
      <td>
        <label style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" ${u.can_edit_delete ? "checked" : ""} ${u.role === "admin" ? "disabled" : ""}
                 onchange="updateUserPermission('${u.id}','can_edit_delete',this.checked)">
        </label>
      </td>
      <td class="mono">${escapeHtml((u.createdAt || "").slice(0, 10))}</td>
      <td>
        <button class="icon-btn view-btn" onclick="openEditUserModal('${u.id}')" title="Edit">&#9998;</button>
        <button class="icon-btn danger" onclick="deleteUser('${u.id}')" title="Delete">&#128465;</button>
      </td>
    </tr>
  `).join("");
}

function openEditUserModal(id) {
  const u = USERS_CACHE[id];
  if (!u) return;
  document.getElementById("eu_id").value = u.id;
  document.getElementById("eu_username").value = u.username;
  document.getElementById("eu_password").value = "";
  document.getElementById("eu_role").value = u.role;
  document.getElementById("eu_can_add").checked = !!u.can_add_data;
  document.getElementById("eu_can_edit").checked = !!u.can_edit_delete;
  document.getElementById("editUserFormError").classList.remove("show");
  document.getElementById("editUserModalBackdrop").classList.add("open");
}

async function updateUserPermission(id, field, value) {
  const res = await fetch(`/api/users/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toastError(err.error || "Could not update.");
    refreshUsersTable();
    return;
  }
  toast("Permission updated");
}

async function deleteUser(id) {
  if (!(await showConfirm("Are you sure you want to delete this user?"))) return;
  const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toastError(err.error || "Could not delete.");
    return;
  }
  toast("User deleted");
  refreshUsersTable();
}

async function initUsersPage() {
  refreshUsersTable();
  const form = document.getElementById("userForm");
  const errBox = document.getElementById("userFormError");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.remove("show");
    const payload = {
      username: document.getElementById("u_username").value.trim(),
      password: document.getElementById("u_password").value,
      role: document.getElementById("u_role").value,
      can_add_data: document.getElementById("u_can_add").checked,
      can_edit_delete: document.getElementById("u_can_edit").checked,
    };
    const res = await fetch("/api/users", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errBox.textContent = err.error || "Something went wrong.";
      errBox.classList.add("show");
      return;
    }
    toast("User added");
    form.reset();
    refreshUsersTable();
  });

  const editBackdrop = document.getElementById("editUserModalBackdrop");
  const editForm = document.getElementById("editUserForm");
  const editErrBox = document.getElementById("editUserFormError");
  const closeEditUser = () => editBackdrop.classList.remove("open");

  document.getElementById("closeEditUserBtn").addEventListener("click", closeEditUser);
  document.getElementById("cancelEditUserBtn").addEventListener("click", closeEditUser);
  editBackdrop.addEventListener("click", (e) => { if (e.target === editBackdrop) closeEditUser(); });

  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    editErrBox.classList.remove("show");
    const id = document.getElementById("eu_id").value;
    const payload = {
      username: document.getElementById("eu_username").value.trim(),
      role: document.getElementById("eu_role").value,
      can_add_data: document.getElementById("eu_can_add").checked,
      can_edit_delete: document.getElementById("eu_can_edit").checked,
    };
    const newPassword = document.getElementById("eu_password").value;
    if (newPassword) payload.password = newPassword;

    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      editErrBox.textContent = err.error || "Something went wrong.";
      editErrBox.classList.add("show");
      return;
    }
    toast("User updated");
    closeEditUser();
    refreshUsersTable();
  });
}

/* ============================================================
   Settings page
   ============================================================ */

const REF_CATEGORY_LABELS = { machine: "Machines", shift: "Shifts", fault: "Fault Categories", technician: "Technicians", complaint: "Complaint Reference", notification: "Notification Type", deviceDetail: "Device Detail", deviceSubCat: "Device Sub-Category" };
const REF_CATEGORY_KEYS = { machine: "machines", shift: "shifts", fault: "faultCategories", technician: "technicians", complaint: "complaintReferences", notification: "notificationTypes", deviceDetail: "deviceDetails", deviceSubCat: "deviceSubCategories" };
const REF_CATEGORY_ICONS = { machine: "&#9881;", shift: "&#128337;", fault: "&#9888;", technician: "&#128119;", complaint: "&#128222;", notification: "&#128276;", deviceDetail: "&#128295;", deviceSubCat: "&#128295;" };
const UNIT_SCOPED_REF_CATEGORIES = ["machine"];

let selectedMachineUnit = "";

function filterRefChips(cat, query) {
  const q = query.trim().toLowerCase();
  const list = document.getElementById(`chips-${cat}`);
  const noMatch = document.getElementById(`no-match-${cat}`);
  let anyVisible = false;
  list.querySelectorAll(".chip").forEach((chip) => {
    const match = !q || chip.dataset.search.includes(q);
    chip.style.display = match ? "" : "none";
    if (match) anyVisible = true;
  });
  if (noMatch) noMatch.style.display = anyVisible ? "none" : "block";
}

async function renderRefGrid() {
  const grid = document.getElementById("refGrid");
  if (!grid) return;

  const units = await loadUnits(true);
  if (!selectedMachineUnit && units.length) selectedMachineUnit = units[0].name;

  const globalRef = await loadReference(true);
  const machineRef = selectedMachineUnit ? await loadReference(true, selectedMachineUnit) : { machines: [] };

  grid.innerHTML = Object.entries(REF_CATEGORY_LABELS).map(([cat, label]) => {
    const isMachine = cat === "machine";
    const items = isMachine ? (machineRef.machines || []) : (globalRef[REF_CATEGORY_KEYS[cat]] || []);
    const unitAttr = isMachine ? `data-unit="${escapeHtml(selectedMachineUnit)}"` : "";

    const unitPicker = isMachine ? `
      <div class="field" style="margin-bottom:10px;">
        <span class="select-wrap">
          <select id="machineUnitPicker" onchange="onMachineUnitChange(this.value)">
            ${units.map((u) => `<option value="${escapeHtml(u.name)}" ${u.name === selectedMachineUnit ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}
          </select>
          <span class="select-caret">&#9662;</span>
        </span>
      </div>` : "";

    const searchBox = items.length > 8 ? `
      <div class="search-box" style="margin-bottom:10px;">
        <span>&#128269;</span>
        <input placeholder="Search in ${label}&hellip;" oninput="filterRefChips('${cat}', this.value)">
      </div>` : "";

    return `
      <div class="card" ${unitAttr}>
        <div class="ref-card-header">
          <h3>${REF_CATEGORY_ICONS[cat] || ""} ${label}</h3>
          <span class="ref-count-badge">${items.length}</span>
        </div>
        ${unitPicker}
        ${searchBox}
        <div class="chip-list" id="chips-${cat}">
          ${items.map((v) => `<span class="chip" data-search="${escapeHtml(v.toLowerCase())}">${escapeHtml(v)}<button onclick="removeRefItem('${cat}','${encodeURIComponent(v)}')">&times;</button></span>`).join("")}
        </div>
        <div class="no-rows" id="no-match-${cat}" style="display:none; padding:10px 0;">No matches found.</div>
        <div class="add-ref-row">
          <input class="text-input" id="new-${cat}" placeholder="Add new ${label.toLowerCase()}">
          <button class="btn ghost" onclick="addRefItem('${cat}')">+ Add</button>
        </div>
      </div>
    `;
  }).join("");
}

function onMachineUnitChange(unit) {
  selectedMachineUnit = unit;
  renderRefGrid();
}

async function addRefItem(cat) {
  const input = document.getElementById(`new-${cat}`);
  const value = input.value.trim();
  if (!value) return;
  const body = { value };
  if (UNIT_SCOPED_REF_CATEGORIES.includes(cat)) body.unit = selectedMachineUnit;
  const res = await fetch(`/api/reference/${cat}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toastError(err.error || "Could not add.");
    return;
  }
  input.value = "";
  renderRefGrid();
}

async function removeRefItem(cat, encodedValue) {
  const value = decodeURIComponent(encodedValue);
  if (!(await showConfirm(`Remove "${value}" from the list?`))) return;
  const qs = UNIT_SCOPED_REF_CATEGORIES.includes(cat) ? `?unit=${encodeURIComponent(selectedMachineUnit)}` : "";
  await fetch(`/api/reference/${cat}/${encodeURIComponent(value)}${qs}`, { method: "DELETE" });
  renderRefGrid();
}

async function refreshSettingsUnitsTable() {
  const body = document.getElementById("unitsTableBody");
  if (!body) return;
  const units = await loadUnits(true);
  if (units.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="no-rows">No units found.</td></tr>`;
    return;
  }
  body.innerHTML = units.map((u) => `
    <tr>
      <td><strong>${escapeHtml(u.name)}</strong></td>
      <td class="mono">${u.machineCount ?? 0}</td>
      <td class="mono">${u.recordCount ?? 0}</td>
      <td class="mono">${escapeHtml((u.createdAt || "").slice(0, 10))}</td>
      <td><button class="icon-btn danger" onclick="deleteUnitFromSettings('${u.id}')" title="Delete">&#128465;</button></td>
    </tr>
  `).join("");
}

async function deleteUnitFromSettings(id) {
  if (!(await showConfirm("Are you sure you want to delete this unit? Its past data will remain in the records."))) return;
  const res = await fetch(`/api/units/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toastError(err.error || "Could not delete.");
    return;
  }
  toast("Unit deleted");
  refreshSettingsUnitsTable();
}

async function initAccountPage() {
  const pwForm = document.getElementById("pwForm");
  const errBox = document.getElementById("pwFormError");
  const okBox = document.getElementById("pwFormSuccess");

  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.remove("show");
    okBox.classList.remove("show");
    const payload = {
      currentPassword: document.getElementById("currentPassword").value,
      newPassword: document.getElementById("newPassword").value,
    };
    const res = await fetch("/api/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errBox.textContent = err.error || "Something went wrong.";
      errBox.classList.add("show");
      return;
    }
    okBox.classList.add("show");
    pwForm.reset();
  });
}

async function initSettingsPage() {
  renderRefGrid();
  if (document.getElementById("unitsTableBody")) refreshSettingsUnitsTable();

  const addUnitBtn = document.getElementById("addUnitBtn");
  if (addUnitBtn) {
    addUnitBtn.addEventListener("click", async () => {
      const input = document.getElementById("newUnitName");
      const name = input.value.trim();
      const errBox = document.getElementById("unitFormError");
      errBox.classList.remove("show");
      if (!name) return;
      const res = await fetch("/api/units", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        errBox.textContent = err.error || "Could not add.";
        errBox.classList.add("show");
        return;
      }
      input.value = "";
      toast("Unit added");
      refreshSettingsUnitsTable();
    });
  }

  document.querySelectorAll(".settings-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".settings-panel").forEach((p) => (p.style.display = "none"));
      btn.classList.add("active");
      const panel = document.getElementById(`tab-${btn.dataset.tab}`);
      if (panel) panel.style.display = "";
    });
  });
}

/* ============================================================
   Technician Performance page
   ============================================================ */
let PERF_HOURS_MAP = {};

async function initPerformancePage() {
  const techSel = document.getElementById("perfTechnician");
  const yearSel = document.getElementById("perfYear");
  const monthSel = document.getElementById("perfMonth");

  const ref = await loadReference();
  (ref.technicians || []).forEach((t) => {
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    techSel.appendChild(o);
  });

  populateYearSelect(yearSel);
  // populateYearSelect adds an "All years" empty option first — for performance
  // we always need a concrete year, so default to the current year.
  yearSel.value = String(new Date().getFullYear());

  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m); o.textContent = MONTH_NAMES[m];
    monthSel.appendChild(o);
  }

  PERF_HOURS_MAP = await fetch("/api/technician-hours").then((r) => r.json()).catch(() => ({}));

  techSel.addEventListener("change", () => {
    const t = techSel.value;
    const box = document.getElementById("perfHoursBox");
    if (t) {
      box.style.display = "";
      document.getElementById("perfHours").value = PERF_HOURS_MAP[t] ?? 8;
    } else {
      box.style.display = "none";
    }
    refreshPerformance();
  });
  yearSel.addEventListener("change", refreshPerformance);
  monthSel.addEventListener("change", refreshPerformance);

  const saveBtn = document.getElementById("perfHoursSave");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const t = techSel.value;
      if (!t) return;
      const hours = parseFloat(document.getElementById("perfHours").value);
      const errBox = document.getElementById("perfHoursError");
      const okBox = document.getElementById("perfHoursSuccess");
      errBox.classList.remove("show"); okBox.classList.remove("show");
      setBtnLoading(saveBtn, true, "Saving&hellip;");
      const res = await fetch("/api/technician-hours", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ technician: t, dailyHours: hours }),
      });
      setBtnLoading(saveBtn, false);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        errBox.textContent = e.error || "Could not save hours.";
        errBox.classList.add("show");
        return;
      }
      PERF_HOURS_MAP[t] = hours;
      okBox.classList.add("show");
      setTimeout(() => okBox.classList.remove("show"), 2500);
      refreshPerformance();
    });
  }
}


function effClass(pct) {
  if (pct >= 75) return "eff-good";
  if (pct >= 40) return "eff-mid";
  return "eff-low";
}
function effColor(pct) {
  if (pct >= 75) return "var(--good)";
  if (pct >= 40) return "var(--warn)";
  return "var(--critical)";
}
// solid hex for canvas/SVG (Chart.js and the gauge can't read CSS vars)
function effHex(pct) {
  if (pct >= 75) return "#1f9d6b";
  if (pct >= 40) return "#cc8420";
  return "#d1495b";
}
function effHexBright(pct) {
  if (pct >= 75) return "#34d399";
  if (pct >= 40) return "#fbbf24";
  return "#f87171";
}
function effRating(pct) {
  if (pct >= 75) return "High";
  if (pct >= 40) return "Moderate";
  return "Low";
}
function effCell(pct) {
  const width = Math.min(pct, 100);
  return `<div class="eff-cell">
    <div class="eff-bar-track"><div class="eff-bar-fill" style="width:${width}%; background:${effColor(pct)};"></div></div>
    <span class="eff-value ${effClass(pct)}">${pct.toFixed(1)}%</span>
  </div>`;
}

function renderPerfGauge(pct) {
  const r = 84, cx = 100, cy = 100;
  const C = 2 * Math.PI * r;
  const filled = (Math.min(Math.max(pct, 0), 100) / 100) * C;
  const color = effHexBright(pct);
  document.getElementById("perfGauge").innerHTML = `
    <svg viewBox="0 0 200 200" width="200" height="200">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="16"></circle>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="16"
              stroke-linecap="round" stroke-dasharray="${filled} ${C - filled}"></circle>
    </svg>
    <div class="perf-gauge-center">
      <div class="perf-gauge-pct" style="color:${color};">${pct.toFixed(1)}<span style="font-size:20px;">%</span></div>
      <div class="perf-gauge-rating">${effRating(pct)} utilisation</div>
    </div>`;
}

async function refreshPerformance() {
  const t = document.getElementById("perfTechnician").value;
  const year = document.getElementById("perfYear").value || String(new Date().getFullYear());
  const month = document.getElementById("perfMonth").value;
  const empty = document.getElementById("perfEmpty");
  const content = document.getElementById("perfContent");

  if (!t) { empty.style.display = ""; content.style.display = "none"; return; }
  empty.style.display = "none"; content.style.display = "";

  const params = new URLSearchParams({ technician: t, year });
  if (month) params.set("month", month);
  const data = await fetch("/api/technician-performance?" + params.toString()).then((r) => r.json());
  const s = data.summary;

  // ----- identity + gauge -----
  const initials = t.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  document.getElementById("perfAvatar").textContent = initials || "--";
  document.getElementById("perfName").textContent = t;
  document.getElementById("perfIdentSub").textContent = `${data.dailyHours}h/day \u00B7 ${s.label}`;
  document.getElementById("perfScopeLabel").textContent = s.label;
  renderPerfGauge(s.efficiency);

  // ----- stat tiles -----
  const avgPerDay = s.daysWorked ? Math.round(s.minutes / s.daysWorked) : 0;
  let busiestLabel = "\u2014", busiestVal = "\u2014";
  if (data.scope === "month" && data.days.length) {
    const top = data.days.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    busiestLabel = "Busiest day";
    busiestVal = `${fmtMinutes(top.minutes)} \u00B7 ${top.date.slice(8)} ${MONTH_NAMES[parseInt(top.date.slice(5,7),10)].slice(0,3)}`;
  } else if (data.scope === "year" && data.months.length) {
    const top = data.months.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    busiestLabel = "Busiest month";
    busiestVal = `${fmtMinutes(top.minutes)} \u00B7 ${top.monthName.slice(0,3)}`;
  }
  document.getElementById("perfTiles").innerHTML = `
    <div class="perf-tile">
      <div class="perf-tile-label"><span class="perf-tile-icon">&#9201;</span> Total time worked</div>
      <div class="perf-tile-value">${fmtMinutes(s.minutes)}</div>
      <div class="perf-tile-sub">across ${s.hoursAvailable}h of available time</div>
    </div>
    <div class="perf-tile">
      <div class="perf-tile-label"><span class="perf-tile-icon">&#128197;</span> Days worked</div>
      <div class="perf-tile-value">${s.daysWorked}</div>
      <div class="perf-tile-sub">days with at least one breakdown</div>
    </div>
    <div class="perf-tile">
      <div class="perf-tile-label"><span class="perf-tile-icon">&#128202;</span> Average / active day</div>
      <div class="perf-tile-value">${fmtMinutes(avgPerDay)}</div>
      <div class="perf-tile-sub">mean time worked per active day</div>
    </div>
    <div class="perf-tile">
      <div class="perf-tile-label"><span class="perf-tile-icon">&#128293;</span> ${busiestLabel}</div>
      <div class="perf-tile-value" style="font-size:17px;">${busiestVal}</div>
      <div class="perf-tile-sub">highest recorded workload</div>
    </div>`;

  // ----- trend chart -----
  renderPerfTrend(data, year, month);

  // ----- detail table -----
  renderPerfTable(data);
}

function renderPerfTrend(data, year, month) {
  const title = document.getElementById("perfTrendTitle");
  let labels = [], values = [], mins = [];
  if (data.scope === "month") {
    title.textContent = `Efficiency by day \u2014 ${data.summary.label}`;
    // show EVERY day of the month; days with no work show 0
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const daysInMonth = new Date(y, m, 0).getDate();
    const byDay = {};
    data.days.forEach((d) => { byDay[parseInt(d.date.slice(8), 10)] = d; });
    for (let day = 1; day <= daysInMonth; day++) {
      labels.push(String(day).padStart(2, "0"));
      values.push(byDay[day] ? byDay[day].efficiency : 0);
      mins.push(byDay[day] ? byDay[day].minutes : 0);
    }
  } else {
    title.textContent = `Efficiency by month \u2014 ${data.summary.label}`;
    // show all 12 months; months with no work show 0
    const byMonth = {};
    data.months.forEach((mm) => { byMonth[mm.month] = mm; });
    for (let mo = 1; mo <= 12; mo++) {
      labels.push(MONTH_NAMES[mo].slice(0, 3));
      values.push(byMonth[mo] ? byMonth[mo].efficiency : 0);
      mins.push(byMonth[mo] ? byMonth[mo].minutes : 0);
    }
  }
  const maxVal = values.length ? Math.max(...values) : 0;
  const yMax = maxVal <= 100 ? Math.max(20, Math.ceil(maxVal / 10) * 10) : Math.ceil(maxVal / 10) * 10;

  if (charts.perfTrend) charts.perfTrend.destroy();
  const ctx = document.getElementById("perfTrendChart");
  charts.perfTrend = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map((v) => effHex(v)),
        borderRadius: 4,
        maxBarThickness: 46,
        _mins: mins,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const m = item.dataset._mins[item.dataIndex];
              return `Efficiency ${item.parsed.y.toFixed(1)}%  (${fmtMinutes(m)})`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#64748b", font: { size: 11 } } },
        y: {
          beginAtZero: true, max: yMax,
          grid: { color: "#e6ebf1" },
          ticks: { color: "#64748b", font: { size: 11 }, callback: (v) => v + "%" },
        },
      },
    },
  });
}

async function togglePerfDayDetail(row) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains("perf-detail-row")) {
    next.remove();
    row.classList.remove("perf-day-open");
    return;
  }
  // close any other open detail row
  document.querySelectorAll(".perf-detail-row").forEach((r) => r.remove());
  document.querySelectorAll(".perf-day-row.perf-day-open").forEach((r) => r.classList.remove("perf-day-open"));

  const tech = document.getElementById("perfTechnician").value;
  const date = row.dataset.date;
  row.classList.add("perf-day-open");

  const tr = document.createElement("tr");
  tr.className = "perf-detail-row";
  tr.innerHTML = `<td colspan="5"><div class="perf-detail-wrap">Loading&hellip;</div></td>`;
  row.after(tr);

  const data = await fetch(`/api/technician-day-detail?technician=${encodeURIComponent(tech)}&date=${encodeURIComponent(date)}`)
    .then((r) => r.json()).catch(() => null);
  const wrap = tr.querySelector(".perf-detail-wrap");
  if (!data || !data.items || !data.items.length) {
    wrap.innerHTML = `<div class="perf-detail-empty">No breakdown details found for this day.</div>`;
    return;
  }
  const rowsHtml = data.items.map((it) => {
    const mc = escapeHtml(it.machine) + (it.machineNo ? ` <span class="perf-mc-no">#${escapeHtml(it.machineNo)}</span>` : "");
    const time = (it.timeStart || "--") + " – " + (it.timeFinish || "--");
    return `<tr>
      <td>${mc}</td>
      <td>${escapeHtml(it.faultCategory || "—")}</td>
      <td>${escapeHtml(it.shift || "—")}</td>
      <td class="mono">${time}</td>
      <td class="downtime-cell">${fmtMinutes(it.minutes)}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `
    <div class="perf-detail-title">Where the time went on <strong>${escapeHtml(date)}</strong> — ${data.count} job(s), total ${fmtMinutes(data.totalMinutes)}</div>
    <table class="perf-detail-table">
      <thead><tr><th>Machine</th><th>Fault</th><th>Shift</th><th>Time</th><th>Duration</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

async function savePerfDayHours(date, value) {
  const tech = document.getElementById("perfTechnician").value;
  if (!tech || !date) return;
  const okBox = document.getElementById("perfHoursSuccess");
  const errBox = document.getElementById("perfHoursError");
  okBox.classList.remove("show"); errBox.classList.remove("show");
  const res = await fetch("/api/technician-day-hours", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ technician: tech, date, dailyHours: value }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    errBox.textContent = e.error || "Could not save hours for that day.";
    errBox.classList.add("show");
    return;
  }
  okBox.textContent = `Hours for ${date} updated — efficiency recalculated.`;
  okBox.classList.add("show");
  setTimeout(() => okBox.classList.remove("show"), 2500);
  refreshPerformance();
}

function renderPerfTable(data) {
  const s = data.summary;
  const head = document.getElementById("perfTableHead");
  const body = document.getElementById("perfTableBody");
  const foot = document.getElementById("perfTableFoot");
  const title = document.getElementById("perfTableTitle");
  const scopeInfo = document.getElementById("perfScopeInfo");

  const canEdit = window.PERF_CAN_EDIT_HOURS === true;

  if (data.scope === "month") {
    title.textContent = `Day-by-day detail \u2014 ${s.label}`;
    scopeInfo.textContent = `${data.days.length} day(s) worked`;
    head.innerHTML = `<tr><th>Date</th><th>Breakdowns</th><th>Time worked</th><th>Hours / day</th><th>Efficiency</th></tr>`;
    if (!data.days.length) {
      body.innerHTML = `<tr><td colspan="5" class="no-rows">No work recorded for this month.</td></tr>`;
      foot.innerHTML = "";
    } else {
      body.innerHTML = data.days.map((d) => {
        const hoursCell = canEdit
          ? `<input class="perf-day-hours ${d.isOverride ? 'is-override' : ''}" type="number" min="1" max="24" step="0.5" value="${d.hours}" data-date="${escapeHtml(d.date)}" title="Working hours for this day">`
          : `<span class="perf-day-hours-ro">${d.hours}h${d.isOverride ? ' *' : ''}</span>`;
        return `
        <tr class="perf-day-row" data-date="${escapeHtml(d.date)}" title="Click to see where this day's time went">
          <td class="mono"><span class="perf-caret">&#9656;</span> ${escapeHtml(d.date)}</td>
          <td>${d.breakdowns}</td>
          <td class="downtime-cell">${fmtMinutes(d.minutes)}</td>
          <td>${hoursCell}</td>
          <td>${effCell(d.efficiency)}</td>
        </tr>`;
      }).join("");
      foot.innerHTML = `<tr>
        <td>Total \u00B7 ${s.label}</td><td></td>
        <td class="downtime-cell">${fmtMinutes(s.minutes)}</td>
        <td class="mono" style="color:var(--ink-3); font-weight:500;">${s.hoursAvailable}h total</td>
        <td>${effCell(s.efficiency)}</td></tr>`;

      if (canEdit) {
        body.querySelectorAll(".perf-day-hours").forEach((inp) => {
          inp.addEventListener("change", (e) => { e.stopPropagation(); savePerfDayHours(inp.dataset.date, inp.value); });
          inp.addEventListener("click", (e) => e.stopPropagation());
        });
      }
      // click a day row to expand where the time went
      body.querySelectorAll(".perf-day-row").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest(".perf-day-hours")) return;
          togglePerfDayDetail(row);
        });
      });
    }
  } else {
    title.textContent = `Month-by-month detail \u2014 ${s.label}`;
    scopeInfo.textContent = `${data.months.length} month(s) with activity`;
    head.innerHTML = `<tr><th>Month</th><th>Days worked</th><th>Time worked</th><th>Monthly efficiency</th></tr>`;
    if (!data.months.length) {
      body.innerHTML = `<tr><td colspan="4" class="no-rows">No work recorded for this year.</td></tr>`;
      foot.innerHTML = "";
    } else {
      body.innerHTML = data.months.map((m) => `
        <tr>
          <td>${escapeHtml(m.monthName)}</td>
          <td>${m.daysWorked}</td>
          <td class="downtime-cell">${fmtMinutes(m.minutes)}</td>
          <td>${effCell(m.efficiency)}</td>
        </tr>`).join("");
      foot.innerHTML = `<tr>
        <td>Yearly \u00B7 ${s.label}</td>
        <td>${s.daysWorked}</td>
        <td class="downtime-cell">${fmtMinutes(s.minutes)}</td>
        <td>${effCell(s.efficiency)}</td></tr>`;
    }
  }
}
