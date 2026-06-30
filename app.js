const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const currency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0
});

const today = new Date();
const todayISO = today.toISOString().slice(0, 10);
const storageKey = "strongwolf-pro-state-v2";

const assetDepreciationTypes = {
  edificios: { label: "Edificios y construcciones", usefulLifeYears: 20, annualRate: 2.22, source: "siemprealdia+1" },
  maquinaria: { label: "Maquinaria", usefulLifeYears: 10, annualRate: 10, source: "siemprealdia+1" },
  oficina: { label: "Equipos de oficina", usefulLifeYears: 5, annualRate: 20, source: "gerencie" },
  muebles: { label: "Muebles y enseres", usefulLifeYears: 10, annualRate: 10, source: "gerencie" }
};

const seed = {
  session: null,
  active: "dashboard",
  catalogTab: "servicios",
  inventoryTab: "activos",
  memberQuery: "",
  memberFilter: "todos",
  reportPeriod: "mensual",
  screenHistory: [],
  pin: "",
  role: "alfa",
  deleteCodes: [],
  users: [
    { id: "sw-user-sebastian-miranda-001", name: "sebastian miranda", displayName: "Sebastian Miranda", role: "alfa", pin: "123687", password: "123687", status: "Activo", createdAt: "2025-01-01" }
  ],
  financeModel: {
    cash: 0,
    banks: 0,
    receivables: 0,
    inventoryValue: 0,
    currentLiabilities: 0,
    totalDebt: 0,
    equity: 0,
    fixedAssets: 0,
    monthlySalesTarget: 0,
    capitalCostRate: 0
  },
  products: [],
  services: [
    { id: "sw-svc-membresia-mensual-001", type: "servicio", name: "Membresia Mensual", price: 85000, status: "Activo", durationDays: 30, entries: 0, planType: "tiempo" },
    { id: "sw-svc-membresia-trimestral-001", type: "servicio", name: "Membresia Trimestral", price: 230000, status: "Activo", durationDays: 90, entries: 0, planType: "tiempo" },
    { id: "sw-svc-tiketera-15-001", type: "servicio", name: "Tiketera 15 entradas", price: 120000, status: "Activo", durationDays: 30, entries: 15, planType: "tiketera" },
    { id: "sw-svc-plan-pareja-001", type: "servicio", name: "Plan Pareja", price: 150000, status: "Activo", durationDays: 30, entries: 0, planType: "tiempo" }
  ],
  activePlans: [],
  ticketUses: [],
  members: [],
  assets: [],
  incomes: [],
  expenses: [],
  campaigns: [],
  audit: []
};

let state = loadState();
let lockUntil = 0;
let failedPins = 0;
let cloudClient = null;
let cloudHydrated = false;
let cloudSaveTimer = null;
let memberSearchTimer = null;

function cloudConfig() {
  return window.STRONGWOLF_CLOUD || {};
}

function cloudEnabled() {
  const cfg = cloudConfig();
  return Boolean(cfg.enabled && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
}

function mergeWithSeed(source) {
  const merged = { ...seed, ...source, pin: "", screenHistory: [] };
  // Preservar sesion activa del source
  merged.session = source.session || null;
  // Garantizar que el usuario administrador seed siempre exista
  const seedUser = seed.users[0];
  const hasSeedUser = (merged.users || []).some((u) => u.id === seedUser.id);
  if (!hasSeedUser) merged.users = [seedUser, ...(merged.users || [])];
  // Garantizar que los servicios seed existan si no hay servicios en absoluto
  if (!merged.services || merged.services.length === 0) merged.services = [...seed.services];
  // Normalizar usuarios
  merged.users = merged.users.map((user) => ({ ...user, password: user.password || user.pin || "" }));
  // Normalizar activos
  merged.assets = (merged.assets || []).map(normalizeAsset);
  return merged;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return saved ? mergeWithSeed(saved) : { ...seed };
  } catch {
    return { ...seed };
  }
}

function saveState() {
  const safe = { ...state, pin: "" };
  localStorage.setItem(storageKey, JSON.stringify(safe));
  scheduleCloudSave(safe);
}

function scheduleCloudSave(safeState = { ...state, pin: "" }) {
  if (!cloudEnabled()) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => saveCloudState(safeState), 650);
}

async function initCloudSync() {
  if (!cloudEnabled()) return;
  const cfg = cloudConfig();
  try {
    cloudClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data, error } = await cloudClient
      .from(cfg.table)
      .select("state, updated_at")
      .eq("id", cfg.rowId)
      .maybeSingle();
    if (error) throw error;
    if (data?.state) {
      // Siempre tomar los datos del servidor al cargar la pagina
      // Solo preservar la sesion activa local para no botar al usuario
      const currentSession = state.session;
      const currentScreen = state.active;
      state = mergeWithSeed(data.state);
      if (currentSession && !state.session) state.session = currentSession;
      state.active = currentScreen || state.active;
      state._lastSaved = data.updated_at;
      pollCloudState._lastServerTime = new Date(data.updated_at).getTime();
      localStorage.setItem(storageKey, JSON.stringify({ ...state, pin: "" }));
    } else {
      // No hay datos en servidor - subir los locales
      await saveCloudState({ ...state, pin: "" }, true);
    }
    cloudHydrated = true;
    showToast("✓ Datos sincronizados con servidor.");
    render();
  } catch (error) {
    console.warn("Strongwolf cloud sync disabled:", error);
    cloudHydrated = false;
    showToast("⚠ Sin conexion al servidor. Trabajando en modo local.");
    render();
  }
}

async function saveCloudState(safeState = { ...state, pin: "" }, force = false) {
  if (!cloudEnabled()) return;
  if (!cloudClient) {
    const cfg = cloudConfig();
    cloudClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }
  if (!cloudHydrated && !force) return;
 
  const cfg = cloudConfig();
  try {
    const timestamp = new Date().toISOString();
    const { error } = await cloudClient
      .from(cfg.table)
      .upsert({ id: cfg.rowId, state: safeState, updated_at: timestamp }, { onConflict: "id" });

    if (error) {
      console.error("Strongwolf Supabase save error:", error.message);
      showToast("Error al guardar en servidor: " + error.message);
    } else {
      state._lastSaved = timestamp;
    }
  } catch (err) {
    console.warn("Strongwolf cloud save failed:", err);
    showToast("⚠ Error al guardar en servidor. Verifica tu conexion.");
  }
}
function wolfMark(size = "large") {
  const cls = size === "small" ? "wolf-mark small" : "wolf-mark";
  return `
    <div class="${cls}" aria-hidden="true">
      <svg viewBox="0 0 220 190" role="img">
        <defs>
          <linearGradient id="wolfGlow" x1="0" x2="1">
            <stop offset="0%" stop-color="#39FF14"/>
            <stop offset="100%" stop-color="#FFD700"/>
          </linearGradient>
        </defs>
        <path d="M110 12 76 54 38 42 54 90 34 120 75 119 90 163 110 132 130 163 145 119 186 120 166 90 182 42 144 54Z" fill="#111" stroke="url(#wolfGlow)" stroke-width="7" stroke-linejoin="round"/>
        <path d="M80 88 100 78 96 101 76 104Z" fill="#39FF14"/>
        <path d="M140 88 120 78 124 101 144 104Z" fill="#39FF14"/>
        <path d="M92 122 Q110 137 128 122" fill="none" stroke="#FFD700" stroke-width="7" stroke-linecap="round"/>
        <path d="M88 146 H132" stroke="#39FF14" stroke-width="8" stroke-linecap="round"/>
      </svg>
    </div>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function money(value) {
  return currency.format(Number(value || 0));
}

function todays(items) {
  return activeMovements(items).filter((item) => item.date === todayISO);
}

function activeMovements(items) {
  return items.filter((item) => !item.deletedAt);
}

function addDays(dateISO, days) {
  const date = new Date(`${dateISO}T00:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function daysBetween(startISO, endISO = todayISO) {
  if (!startISO) return 0;
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function normalizeAsset(asset) {
  const typeKey = asset.assetType || inferAssetType(asset.category);
  const originalValue = Number(asset.originalValue ?? asset.value ?? 0);
  const purchaseDate = asset.purchaseDate || asset.createdAt || todayISO;
  return {
    ...asset,
    assetType: typeKey,
    originalValue,
    purchaseDate,
    value: depreciatedAssetValue({ ...asset, assetType: typeKey, originalValue, purchaseDate })
  };
}

function inferAssetType(category = "") {
  const text = String(category).toLowerCase();
  if (text.includes("oficina")) return "oficina";
  if (text.includes("mueble") || text.includes("enser")) return "muebles";
  if (text.includes("edificio") || text.includes("constru")) return "edificios";
  return "maquinaria";
}

function depreciationType(key) {
  return assetDepreciationTypes[key] || assetDepreciationTypes.maquinaria;
}

function depreciatedAssetValue(asset, endISO = todayISO) {
  const original = Number(asset.originalValue ?? asset.value ?? 0);
  const type = depreciationType(asset.assetType);
  const daily = original * (type.annualRate / 100) / 365;
  const depreciation = Math.min(original, daily * daysBetween(asset.purchaseDate, endISO));
  return Math.max(0, Math.round(original - depreciation));
}

function assetDepreciation(asset, endISO = todayISO) {
  const normalized = normalizeAsset(asset);
  const type = depreciationType(normalized.assetType);
  const daily = Number(normalized.originalValue || 0) * (type.annualRate / 100) / 365;
  const accumulated = Math.min(Number(normalized.originalValue || 0), daily * daysBetween(normalized.purchaseDate, endISO));
  return {
    type,
    daily,
    accumulated,
    currentValue: Math.max(0, Math.round(Number(normalized.originalValue || 0) - accumulated))
  };
}

function depreciationForPeriod(period) {
  const days = { semanal: 7, mensual: 30, anual: 365 }[period] || 30;
  return state.assets.reduce((sum, asset) => sum + assetDepreciation(asset).daily * days, 0);
}

function syncAssetValues() {
  state.assets = state.assets.map(normalizeAsset);
  state.financeModel.fixedAssets = state.assets.reduce((sum, asset) => sum + depreciatedAssetValue(asset), 0);
}

function syncMemberStatuses() {
  state.activePlans.forEach((plan) => {
    if (plan.status === "Activo" && planExpired(plan)) plan.status = "Vencido";
  });
  state.members.filter((m) => !m.deletedAt).forEach((member) => {
    const hasTrackedPlan = state.activePlans.some((plan) => plan.memberId === member.id);
    const activePlan = state.activePlans.some((plan) => plan.memberId === member.id && plan.status === "Activo" && !planExpired(plan));
    const legacyActive = !hasTrackedPlan && member.due && member.due >= todayISO;
    member.active = Boolean(activePlan || legacyActive);
  });
}

function totals() {
  const income = todays(state.incomes).reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = todays(state.expenses).reduce((sum, item) => sum + Number(item.amount), 0);
  return { income, expense, profit: income - expense };
}

function buildAlerts() {
  const alerts = [];
  // Cumpleaños hoy
  const birthdays = state.members.filter((m) => m.birthday && m.birthday.slice(5) === todayISO.slice(5));
  if (birthdays.length) alerts.push(`<div class="list-item warn">${icon("messaging")} ${birthdays.length} cumpleaños hoy: ${birthdays.map((m) => m.name).join(", ")}</div>`);
  // Membresías que vencen en los próximos 7 días
  const soonExpiring = state.members.filter((m) => {
    if (!m.due || !m.active) return false;
    const days = daysBetween(todayISO, m.due);
    return days >= 0 && days <= 7;
  });
  if (soonExpiring.length) alerts.push(`<div class="list-item warn">${icon("members")} ${soonExpiring.length} membresía(s) vencen esta semana</div>`);
  // Stock bajo (3 unidades o menos)
  const lowStock = state.products.filter((p) => p.status === "Activo" && Number(p.stock ?? 0) <= 3);
  lowStock.forEach((p) => alerts.push(`<div class="list-item bad">${icon("inventory")} Stock bajo: ${p.name} (${p.stock} uds)</div>`));
  // Activos en mantenimiento
  const inMaintenance = state.assets.filter((a) => a.status !== "Operativa");
  if (inMaintenance.length) alerts.push(`<div class="list-item warn">${icon("fang")} ${inMaintenance.length} equipo(s) fuera de servicio</div>`);
  return alerts.length ? alerts.join("") : `<div class="empty">Sin alertas activas.</div>`;
}

let birthdayAlertShown = false;
function checkBirthdayAlerts() {
  if (birthdayAlertShown) return;
  const birthdays = state.members.filter((m) => m.birthday && m.birthday.slice(5) === todayISO.slice(5));
  if (birthdays.length) {
    birthdayAlertShown = true;
    showToast(`🎂 Hoy es el cumpleaños de: ${birthdays.map((m) => m.name).join(", ")}`);
  }
}

function addAudit(action, detail = "") {
  state.audit.unshift({
    id: crypto.randomUUID(),
    at: new Date().toLocaleString("es-CO"),
    user: state.session?.name || "Sistema",
    role: state.session?.role || "Automatico",
    action,
    detail
  });
  state.audit = state.audit.slice(0, 80);
}

function setScreen(screen) {
  if (!canAccess(screen)) {
    showToast("Acceso restringido al perfil Alfa.");
    screen = "dashboard";
  }
  if (state.active !== screen) state.screenHistory.push(state.active);
  state.active = screen;
  saveState();
  render();
}

function goBack() {
  const previous = state.screenHistory.pop();
  state.active = previous && canAccess(previous) ? previous : "dashboard";
  saveState();
  render();
}

function isAlfa() {
  return state.session?.role === "alfa";
}

function canAccess(screen) {
  const alfaOnly = ["finance", "settings", "audit", "report", "fang"];
  return isAlfa() || !alfaOnly.includes(screen);
}

function render() {
  if (!state.session) {
    renderSplash();
    return;
  }
  syncAssetValues();
  syncMemberStatuses();
  checkBirthdayAlerts();
  app.innerHTML = layout(renderScreen());
  bindCommon();
}

function renderSplash() {
  app.innerHTML = `
    <section class="splash">
      <div class="brand-stack">
        ${wolfMark()}
        <h1 class="brand-title">Strongwolf</h1>
        <p class="brand-subtitle">Training Center</p>
        <div class="loader" aria-label="Cargando aplicacion"><span></span></div>
      </div>
    </section>`;
  setTimeout(renderLogin, 1200);
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-card" id="loginCard">
        ${wolfMark("small")}
        <h1 class="brand-title" style="font-size:46px">Strongwolf</h1>
        <p class="brand-subtitle">Training Center</p>
        <h2 class="card-title">Ingresar al sistema</h2>
        <form id="loginForm" class="form-grid login-form">
          <div class="field full">
            <label for="loginUser">Nombre de usuario</label>
            <input id="loginUser" name="username" autocomplete="username" required />
          </div>
          <div class="field full">
            <label for="loginRole">Perfil</label>
            <select id="loginRole" name="role">
              <option value="alfa">Administrativo</option>
              <option value="cachorro">Operativo</option>
            </select>
          </div>
          <div class="field full">
            <label for="loginPassword">Contrasena</label>
            <input id="loginPassword" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="actions field full"><button class="primary-btn" type="submit">Entrar</button></div>
        </form>
      </div>
    </section>`;
  document.querySelector("#loginForm")?.addEventListener("submit", validateLogin);
}

function pressKey(key) {
  if (Date.now() < lockUntil) {
    showToast(`Bloqueado por ${Math.ceil((lockUntil - Date.now()) / 1000)} segundos`);
    return;
  }
  if (key === "back") state.pin = state.pin.slice(0, -1);
  else if (key === "enter") {
    validateLogin();
    return;
  }
  else if (state.pin.length < 6) state.pin += key;
  renderLogin();
}

function validateLogin(event) {
  event?.preventDefault();
  const data = event ? Object.fromEntries(new FormData(event.target)) : {};
  const username = String(data.username || "").trim().toLowerCase();
  const password = String(data.password || state.pin || "");
  const role = data.role || state.role;
  const user = state.users.find((item) => item.role === role && item.status === "Activo" && item.name.toLowerCase() === username && (item.password || item.pin) === password);
  if (user) {
    state.session = {
      id: user.id,
      role: user.role,
      name: user.displayName || user.name
    };
    state.pin = "";
    addAudit("Inicio de sesion", `Perfil ${state.session.role}`);
    saveState();
    render();
    return;
  }
  failedPins += 1;
  state.pin = "";
  document.querySelector("#loginCard")?.classList.add("shake");
  if (failedPins >= 3) {
    lockUntil = Date.now() + 30000;
    failedPins = 0;
    showToast("Credenciales incorrectas 3 veces. Bloqueo de 30 segundos.");
  } else {
    showToast("Usuario, perfil o contrasena incorrectos.");
  }
}

function layout(content) {
  const navItems = isAlfa()
    ? [["dashboard", "Inicio"], ["income", "Ingreso"], ["expense", "Gasto"], ["members", "Miembros"], ["finance", "Finanzas"], ["settings", "Config"]]
    : [["dashboard", "Inicio"], ["income", "Ingreso"], ["expense", "Gasto"], ["members", "Miembros"], ["inventory", "Inventario"], ["catalog", "Catalogo"]];
  return `
    <main class="layout">
      <header class="topbar">
        <div class="brand-mini"><span class="brand-dot"></span><strong>STRONGWOLF</strong></div>
        <div class="top-actions">
          <span>${today.toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</span>
          <span class="status-pill ${cloudHydrated ? "online" : cloudEnabled() ? "warn" : "bad"}">${cloudHydrated ? "Online" : cloudEnabled() ? "Conectando..." : "Local"}</span>
          <button class="secondary-btn" id="logoutBtn">Salir</button>
        </div>
      </header>
      <section class="content">${content}</section>
      <nav class="bottom-nav" aria-label="Navegacion principal">
        ${navItems.map(([id, label]) => navButton(id, label)).join("")}
      </nav>
    </main>`;
}

function navButton(id, label) {
  return `<button class="nav-item ${state.active === id ? "active" : ""}" data-screen="${id}">${icon(id)}<br><small>${label}</small></button>`;
}

function icon(id) {
  const icons = {
    dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
    income: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
    expense: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
    members: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg>`,
    finance: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    inventory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
    catalog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    messaging: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    audit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    fang: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 2L8 8l4 14 4-14z"/></svg>`,
    report: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
  };
  return icons[id] || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="1"/></svg>`;
}

function bindCommon() {
  document.querySelectorAll("[data-screen]").forEach((btn) => btn.addEventListener("click", () => setScreen(btn.dataset.screen)));
  document.querySelector("#backBtn")?.addEventListener("click", goBack);
  document.querySelector("#logoutBtn")?.addEventListener("click", () => {
    state.session = null;
    saveState();
    renderLogin();
  });
}

function renderScreen() {
  if (!canAccess(state.active)) state.active = "dashboard";
  const screens = {
    dashboard: dashboardScreen,
    income: incomeScreen,
    expense: expenseScreen,
    members: membersScreen,
    inventory: inventoryScreen,
    finance: financeScreen,
    messaging: messagingScreen,
    settings: settingsScreen,
    audit: auditScreen,
    report: reportScreen,
    catalog: catalogScreen,
    fang: fangScreen
  };
  return (screens[state.active] || dashboardScreen)();
}

function head(title, right = "") {
  return `<div class="screen-head"><button class="back-btn" id="backBtn" aria-label="Volver">←</button><h1 class="screen-title">${title}</h1><div class="screen-actions">${right}</div></div>`;
}

function dashboardScreen() {
  pruneDeleteCodes();
  const total = totals();
  const alpha = state.session.role === "alfa";
  if (!alpha) return receptionDashboard(total);
  return `
    ${head("Panel Alfa", `<span class="status-pill online">Datos en vivo</span>`)}
    <div class="grid">
      ${metricCard("Ingresos del dia", total.income, "+12.5% vs ayer", "span-6")}
      ${metricCard("Gastos hoy", total.expense, "+5% vs ayer", "span-3 expense")}
      ${metricCard("Utilidad hoy", total.profit, "+18% vs ayer", "span-3 profit")}
      <section class="card span-6">
        <h2 class="card-title">Acceso rapido</h2>
        <div class="quick-grid">
          ${quick("income", "income", "Ingreso nuevo")}
          ${quick("expense", "expense", "Gasto nuevo")}
          ${quick("members", "members", "Miembros")}
          ${quick("finance", "finance", "Reportes")}
          ${quick("messaging", "messaging", "El Aullido")}
          ${quick("inventory", "inventory", "Equipos")}
        </div>
      </section>
      <section class="card span-6">
        <h2 class="card-title">Ingresos vs gastos</h2>
        ${chart()}
      </section>
      <section class="card span-4">
        <h2 class="card-title">Alertas</h2>
        <div class="list">
          ${buildAlerts()}
        </div>
      </section>
      <section class="card span-8">
        <h2 class="card-title">Ultimos movimientos</h2>
        ${movementList()}
      </section>
    </div>`;
}

function receptionDashboard(total) {
  return `
    ${head("Panel Recepcion", `<span class="status-pill warn">Perfil operativo</span>`)}
    <div class="grid">
      ${metricCard("Registros de hoy", todays(state.incomes).length + todays(state.expenses).length, "Transacciones guardadas", "span-4", false)}
      ${metricCard("Membresias", todays(state.incomes).filter((i) => i.type === "membresia").length, "Pagos registrados", "span-4 profit", false)}
      ${metricCard("Total cobrado", total.income, "En caja", "span-4")}
      <section class="card span-6">
        <h2 class="card-title">Acciones rapidas</h2>
        <div class="list">
          ${quick("income", "income", "Nueva membresia")}
          ${quick("catalog", "catalog", "Venta de producto")}
          ${quick("expense", "expense", "Registrar gasto")}
          ${quick("members", "members", "Nuevo miembro")}
        </div>
      </section>
      <section class="card span-6">
        <h2 class="card-title">Ultimos registros</h2>
        ${movementList()}
      </section>
    </div>`;
}

function metricCard(title, value, delta, cls, isMoney = true) {
  return `
    <section class="card metric-card ${cls}">
      <h2 class="card-title">${title}</h2>
      <p class="metric">${isMoney ? money(value) : value}</p>
      <div class="delta online">${delta}</div>
    </section>`;
}

function quick(screen, iconId, label) {
  return `<button class="quick-card" data-screen="${screen}">${icon(iconId)}<strong>${label}</strong></button>`;
}

function chart() {
  // Calcular ingresos y gastos de las últimas 4 semanas
  const now = new Date();
  const weeks = [1, 2, 3, 4].map((w) => {
    const endDate = new Date(now);
    endDate.setDate(now.getDate() - (w - 1) * 7);
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - 6);
    const start = startDate.toISOString().slice(0, 10);
    const end = endDate.toISOString().slice(0, 10);
    const income = activeMovements(state.incomes).filter((i) => i.date >= start && i.date <= end).reduce((s, i) => s + Number(i.amount), 0);
    const expense = activeMovements(state.expenses).filter((i) => i.date >= start && i.date <= end).reduce((s, i) => s + Number(i.amount), 0);
    return { label: `Sem ${5 - w}`, income, expense };
  }).reverse();
  const maxVal = Math.max(...weeks.map((w) => Math.max(w.income, w.expense)), 1);
  return `<div class="chart-bars">${weeks.map(({ label, income, expense }) => `
    <div class="bar-row">
      <span>${label}</span>
      <div class="bar income" title="Ingresos: ${money(income)}"><i style="width:${Math.round((income / maxVal) * 100)}%"></i></div>
      <div class="bar expense" title="Gastos: ${money(expense)}"><i style="width:${Math.round((expense / maxVal) * 100)}%"></i></div>
    </div>`).join("")}
  <div style="display:flex;gap:16px;margin-top:8px;font-size:12px;color:var(--muted)"><span style="color:var(--green)">▬ Ingresos</span><span style="color:var(--red)">▬ Gastos</span></div>
  </div>`;
}

function movementList() {
  const movements = [
    ...activeMovements(state.incomes).map((item) => ({ ...item, kind: "Ingreso", collection: "incomes" })),
    ...activeMovements(state.expenses).map((item) => ({ ...item, kind: "Gasto", collection: "expenses" }))
  ].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 6);
  if (!movements.length) return `<div class="empty">Empieza registrando tu primer movimiento.</div>`;
  return `<div class="list">${movements.map((item) => `
    <div class="list-item movement-item">
      <div>
        <strong><span class="movement-icon">${item.kind === "Ingreso" ? icon("income") : icon("expense")}</span>${item.kind}: ${item.name}</strong>
        <span>${item.date} · ${money(item.amount)} · ${item.user}</span>
      </div>
      <button class="dots-btn" data-delete-movement="${item.collection}:${item.id}" aria-label="Opciones de movimiento">⋮</button>
    </div>`).join("")}</div>`;
}

function incomeScreen() {
  const allItems = [...state.services, ...state.products.filter((p) => p.stock > 0)];
  const defaultDue = addDays(todayISO, 30);
  return `
    ${head("Registrar ingreso")}
    <section class="card">
      <form id="incomeForm" class="form-grid">
        <div class="field">
          <label for="incomeType">Tipo de ingreso</label>
          <select id="incomeType" name="type">
            <option value="membresia">Servicio / membresia</option>
            <option value="producto">Producto</option>
            <option value="otro">Otro ingreso</option>
          </select>
        </div>
        <div class="field">
          <label for="incomeItem">Concepto</label>
          <select id="incomeItem" name="item">
            ${allItems.map((item) => `<option value="${item.id}" data-price="${item.price}">${item.name} - ${money(item.price)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="incomeMember">Miembro / cliente</label>
          <input id="incomeMember" name="member" list="memberList" placeholder="Nombre del cliente" required />
          <datalist id="memberList">${state.members.map((m) => `<option value="${m.name}"></option>`).join("")}</datalist>
        </div>
        <div class="field">
          <label for="incomeAmount">Valor</label>
          <input id="incomeAmount" name="amount" type="number" min="0" step="1000" required />
        </div>
        <div class="field">
          <label for="incomeDuration">Duracion del plan en dias</label>
          <input id="incomeDuration" name="durationDays" type="number" min="1" value="30" />
        </div>
        <div class="field">
          <label for="incomeDue">Fecha de vencimiento editable</label>
          <input id="incomeDue" name="due" type="date" value="${defaultDue}" />
        </div>
        <div class="field">
          <label for="incomeEntries">Entradas incluidas</label>
          <input id="incomeEntries" name="entries" type="number" min="0" value="0" />
        </div>
        <div class="field">
          <label for="incomePlanMode">Modo de vencimiento</label>
          <select id="incomePlanMode" name="planMode">
            <option value="tiempo">Vence por fecha</option>
            <option value="tiketera">Vence por entradas o fecha</option>
          </select>
        </div>
        <div class="field full">
          <label for="incomeNote">Nota</label>
          <textarea id="incomeNote" name="note" placeholder="Metodo de pago, referencia o detalle"></textarea>
        </div>
        <div class="actions field full">
          <button class="primary-btn" type="submit">Guardar ingreso</button>
          <button class="secondary-btn" type="button" data-screen="catalog">Ver catalogo</button>
        </div>
      </form>
    </section>`;
}

function expenseScreen() {
  return `
    ${head("Registrar gasto")}
    <section class="card">
      <form id="expenseForm" class="form-grid">
        <div class="field">
          <label for="expenseCategory">Categoria</label>
          <select id="expenseCategory" name="category">
            <option>Nomina</option>
            <option>Arriendo</option>
            <option>Servicios publicos</option>
            <option>Limpieza</option>
            <option>Mantenimiento</option>
            <option>Marketing</option>
          </select>
        </div>
        <div class="field">
          <label for="expenseAmount">Valor</label>
          <input id="expenseAmount" name="amount" type="number" min="0" step="1000" required />
        </div>
        <div class="field full">
          <label for="expenseName">Detalle</label>
          <input id="expenseName" name="name" placeholder="Ej. Compra de desinfectante" required />
        </div>
        <div class="field full">
          <label for="expenseNote">Observacion</label>
          <textarea id="expenseNote" name="note"></textarea>
        </div>
        <div class="actions field full">
          <button class="primary-btn" type="submit">Guardar gasto</button>
        </div>
      </form>
    </section>`;
}

function membersScreen() {
  const query = state.memberQuery.toLowerCase();
  const filtered = state.members.filter((m) => {
    if (m.deletedAt) return false;
    const matches = `${m.name} ${m.doc} ${m.phone}`.toLowerCase().includes(query);
    const status = state.memberFilter === "todos" || (state.memberFilter === "activos" ? m.active : !m.active);
    return matches && status;
  });
  const deletedCount = state.members.filter((m) => m.deletedAt).length;
  return `
    ${head(`Miembros (${state.members.filter((m) => !m.deletedAt).length})`, `<button class="secondary-btn" id="exportMembersExcel">Excel</button><button class="secondary-btn" id="exportMembersPdf">PDF</button><button class="primary-btn" id="quickMember">Nuevo miembro</button>`)}
    <section class="card">
      <div class="filters">
        <input id="memberSearch" placeholder="Buscar por nombre, documento o telefono" value="${state.memberQuery}" />
        <button class="tab ${state.memberFilter === "todos" ? "active" : ""}" data-filter="todos">Todos</button>
        <button class="tab ${state.memberFilter === "activos" ? "active" : ""}" data-filter="activos">Activos</button>
        <button class="tab ${state.memberFilter === "inactivos" ? "active" : ""}" data-filter="inactivos">Inactivos</button>
      </div>
      <div class="member-grid">
        ${filtered.map((m) => `
          <article class="member-card">
            <span class="badge ${m.active ? "online" : "bad"}">${m.active ? "Activo" : "Inactivo"}</span>
            <strong>${m.name}</strong>
            <p>CC: ${m.doc}<br>Tel: ${m.phone}<br>Plan: ${m.plan || "Sin plan"}<br>Vence: ${m.due || "Sin fecha"}<br>Cumple: ${m.birthday}</p>
            ${memberPlanSummary(m)}
            <div class="actions">
              <button class="secondary-btn" data-message="${m.id}">Mensaje</button>
              <button class="secondary-btn" data-renew="${m.id}">Renovar</button>
              <button class="danger-btn" data-delete-member="${m.id}">Eliminar</button>
            </div>
          </article>`).join("") || `<div class="empty">No hay miembros con ese filtro.</div>`}
      </div>
      ${deletedCount > 0 ? `<p style="color:var(--muted);font-size:13px;margin-top:12px">${deletedCount} miembro(s) eliminado(s) conservado(s) en auditoria.</p>` : ""}
    </section>
    <section class="card" style="margin-top:16px">
      <h2 class="card-title">Registro de miembro</h2>
      <form id="memberForm" class="form-grid">
        <div class="field"><label for="memberName">Nombre</label><input id="memberName" name="name" required /></div>
        <div class="field"><label for="memberDoc">Documento</label><input id="memberDoc" name="doc" required /></div>
        <div class="field"><label for="memberPhone">Telefono</label><input id="memberPhone" name="phone" required /></div>
        <div class="field"><label for="memberBirthday">Cumpleanos</label><input id="memberBirthday" name="birthday" type="date" required /></div>
        <div class="actions field full"><button class="primary-btn">Crear miembro</button></div>
      </form>
    </section>`;
}

function inventoryScreen() {
  syncAssetValues();
  return `
    ${head("Inventario", `<button class="primary-btn" data-screen="catalog">Catalogo</button>`)}
    <section class="card">
      <div class="tabs">
        <button class="tab ${state.inventoryTab === "activos" ? "active" : ""}" data-inventory-tab="activos">Activos</button>
        <button class="tab ${state.inventoryTab === "productos" ? "active" : ""}" data-inventory-tab="productos">Productos</button>
      </div>
      ${state.inventoryTab === "activos" ? assetList() : productList()}
    </section>
    <section class="card" style="margin-top:16px">
      <h2 class="card-title">Nuevo activo fijo</h2>
      <form id="assetForm" class="form-grid">
        <div class="field"><label for="assetName">Nombre</label><input id="assetName" name="name" required /></div>
        <div class="field"><label for="assetType">Tipo de activo</label><select id="assetType" name="assetType">${Object.entries(assetDepreciationTypes).map(([key, item]) => `<option value="${key}">${item.label} - ${item.annualRate}% anual</option>`).join("")}</select></div>
        <div class="field"><label for="assetCategory">Categoria interna</label><input id="assetCategory" name="category" placeholder="Ej. Pierna, cardio, recepcion" required /></div>
        <div class="field"><label for="assetValue">Valor de compra</label><input id="assetValue" name="originalValue" type="number" min="0" required /></div>
        <div class="field"><label for="assetPurchaseDate">Fecha de compra</label><input id="assetPurchaseDate" name="purchaseDate" type="date" value="${todayISO}" required /></div>
        <div class="field"><label for="assetNext">Proximo mantenimiento</label><input id="assetNext" name="next" type="date" required /></div>
        <div class="field"><label for="assetStatus">Estado</label><select id="assetStatus" name="status"><option>Operativa</option><option>Mantenimiento</option><option>Fuera de servicio</option></select></div>
        <div class="actions field full"><button class="primary-btn">Guardar activo</button></div>
      </form>
    </section>`;
}

function assetList() {
  if (!state.assets.length) return `<div class="empty">Registra tu primer activo fijo para calcular depreciacion diaria.</div>`;
  return `<div class="product-grid">${state.assets.map((a) => {
    const dep = assetDepreciation(a);
    return `
    <article class="product-card">
      <span class="badge ${a.status === "Operativa" ? "online" : "warn"}">${a.status}</span>
      <strong>${a.name}</strong>
      <p>Tipo: ${dep.type.label}<br>Categoria: ${a.category}<br>Valor compra: ${money(a.originalValue)}<br>Valor real hoy: ${money(dep.currentValue)}<br>Depreciacion diaria: ${money(dep.daily)}<br>Depreciacion acumulada: ${money(dep.accumulated)}<br>Compra: ${a.purchaseDate}<br>Proximo mantenimiento: ${a.next}</p>
      <div class="actions"><button class="secondary-btn" data-maintenance="${a.id}">Registrar mantenimiento</button></div>
    </article>`;
  }).join("")}</div>`;
}

function productList() {
  return `<div class="product-grid">${state.products.map((p) => productCard(p)).join("")}</div>`;
}

function productCard(p) {
  return `
    <article class="product-card">
      <span class="badge ${p.stock <= 3 ? "warn" : "online"}">${p.status}</span>
      <strong>${p.name}</strong>
      <p>Precio: ${money(p.price)}<br>Stock: ${p.stock ?? "N/A"} unidades</p>
      <div class="actions"><button class="secondary-btn" data-sell="${p.id}">Vender</button>${isAlfa() ? `<button class="secondary-btn" data-fang="Editar ${p.name}">Editar</button>` : ""}</div>
    </article>`;
}

function serviceCard(item) {
  return `
    <article class="product-card">
      <span class="badge online">${item.status}</span>
      <strong>${item.name}</strong>
      <p>Precio base: ${money(item.price)}<br>Duracion: ${item.durationDays || 30} dias<br>${item.entries ? `Entradas: ${item.entries}` : "Sin limite de entradas"}</p>
      <div class="actions"><button class="secondary-btn" data-fang="Editar ${item.name}">Editar</button><button class="secondary-btn" data-fang="Descontinuar ${item.name}">Descontinuar</button></div>
    </article>`;
}

function memberPlanSummary(member) {
  const plans = activePlansForMember(member.id);
  if (!plans.length) return `<div class="empty">Sin plan activo registrado.</div>`;
  return `<div class="ticket-stack">${plans.map((plan) => {
    const used = plan.totalEntries ? plan.totalEntries - plan.remainingEntries : 0;
    return `
      <div class="ticket-card">
        <strong>${plan.serviceName}</strong>
        <span>Vence: ${plan.due}</span>
        ${plan.mode === "tiketera" ? `<span>Entradas: ${plan.remainingEntries}/${plan.totalEntries}</span><div class="score-track"><i style="width:${Math.max(0, (plan.remainingEntries / Math.max(plan.totalEntries, 1)) * 100)}%"></i></div>` : `<span>Plan por fecha</span>`}
        <small>Usos registrados: ${used}</small>
        ${plan.mode === "tiketera" && plan.remainingEntries > 0 ? `<button class="primary-btn" data-use-ticket="${plan.id}">Descontar entrada</button>` : ""}
        ${ticketHistory(plan.id)}
      </div>`;
  }).join("")}</div>`;
}

function activePlansForMember(memberId) {
  return state.activePlans
    .filter((plan) => plan.memberId === memberId && plan.status === "Activo")
    .map((plan) => ({ ...plan, status: planExpired(plan) ? "Vencido" : plan.status }))
    .filter((plan) => plan.status === "Activo");
}

function planExpired(plan) {
  return plan.due < todayISO || (plan.mode === "tiketera" && Number(plan.remainingEntries) <= 0);
}

function ticketHistory(planId) {
  const uses = state.ticketUses.filter((use) => use.planId === planId).slice(0, 4);
  if (!uses.length) return `<small>Sin entradas usadas aun.</small>`;
  return `<details><summary>Historial</summary>${uses.map((use) => `<small>${use.date} ${use.time} - ${use.user}</small>`).join("")}</details>`;
}

function financeScreen() {
  syncAssetValues();
  const total = totals();
  const indicators = financialIndicators(total);
  const dailyDepreciation = state.assets.reduce((sum, asset) => sum + assetDepreciation(asset).daily, 0);
  const groups = ["Liquidez", "Actividad", "Endeudamiento", "Rentabilidad", "Inductores de valor"];
  return `
    ${head("Finanzas 360", `<button class="primary-btn" data-screen="report">Informe ejecutivo</button>`)}
    <div class="grid">
      ${metricCard("Ingresos", total.income, "Hoy", "span-3")}
      ${metricCard("Gastos", total.expense, "Hoy", "span-3 expense")}
      ${metricCard("Utilidad", total.profit, "Resultado operativo", "span-3 profit")}
      ${metricCard("Depreciacion diaria", dailyDepreciation, "Activos fijos", "span-3 expense", true)}
      ${metricCard("Valor real activos", state.financeModel.fixedAssets, "Actualizado automatico", "span-3", true)}
      <section class="card span-8">
        <h2 class="card-title">Mapa de salud financiera</h2>
        <div class="radar-grid">
          ${groups.map((group) => {
            const avg = Math.round(indicators.filter((i) => i.group === group).reduce((sum, item) => sum + item.score, 0) / indicators.filter((i) => i.group === group).length);
            return `<div class="radar-item"><span>${group}</span><div class="radar-ring" style="--score:${avg}">${avg}</div></div>`;
          }).join("")}
        </div>
      </section>
      <section class="card span-4">
        <h2 class="card-title">Resumen ejecutivo</h2>
        <div class="list">
          <div class="list-item"><strong>Liquidez inmediata</strong>${indicators.find((i) => i.key === "cashRatio").value}</div>
          <div class="list-item"><strong>Endeudamiento</strong>${indicators.find((i) => i.key === "debtRatio").value}</div>
          <div class="list-item"><strong>Margen neto</strong>${indicators.find((i) => i.key === "netMargin").value}</div>
        </div>
      </section>
      <section class="card span-12">
        <h2 class="card-title">Indicadores por categoria</h2>
        <div class="indicator-grid">
          ${indicators.map(indicatorCard).join("")}
        </div>
      </section>
      <section class="card span-12">
        <h2 class="card-title">Cuentas manuales para completar estados</h2>
        <p style="color:var(--muted)">Ingresos, egresos, utilidad, ticket, ventas e inventario se calculan desde registros. Caja, bancos, cartera, pasivos, deuda, patrimonio, activos fijos y costo de capital se editan manualmente porque normalmente vienen de bancos, prestamos, aportes y contabilidad externa.</p>
        <form id="financeModelForm" class="form-grid">
          ${financeInput("cash", "Caja", state.financeModel.cash)}
          ${financeInput("banks", "Bancos", state.financeModel.banks)}
          ${financeInput("receivables", "Cuentas por cobrar", state.financeModel.receivables)}
          ${financeInput("inventoryValue", "Inventario valorizado", state.financeModel.inventoryValue)}
          ${financeInput("currentLiabilities", "Pasivos corrientes", state.financeModel.currentLiabilities)}
          ${financeInput("totalDebt", "Deuda total", state.financeModel.totalDebt)}
          ${financeInput("equity", "Patrimonio", state.financeModel.equity)}
          ${financeInput("fixedAssets", "Activos fijos depreciados", state.financeModel.fixedAssets)}
          ${financeInput("monthlySalesTarget", "Meta mensual ventas", state.financeModel.monthlySalesTarget)}
          ${financeInput("capitalCostRate", "Costo de capital % anual", state.financeModel.capitalCostRate, 0.1)}
          <div class="actions field full"><button class="primary-btn">Actualizar indicadores</button></div>
        </form>
      </section>
    </div>`;
}

function financialIndicators(total) {
  const model = state.financeModel;
  const income = Number(total.income || 0);
  const assets = model.cash + model.banks + model.receivables + model.inventoryValue + model.fixedAssets;
  const currentAssets = model.cash + model.banks + model.receivables + model.inventoryValue;
  const quickAssets = model.cash + model.banks + model.receivables;
  const monthlyDepreciation = depreciationForPeriod("mensual");
  const profit = total.profit - monthlyDepreciation;
  const ebitda = total.profit;
  const investedCapital = model.totalDebt + model.equity;
  const roic = investedCapital ? (profit / investedCapital) * 100 : 0;
  const eva = profit - investedCapital * (model.capitalCostRate / 100 / 12);
  return [
    ratio("currentRatio", "Liquidez", "Razon corriente", model.currentLiabilities > 0 ? currentAssets / model.currentLiabilities : 0, "x", "Mide si los activos corrientes alcanzan para cubrir obligaciones de corto plazo.", 1.5, 3, false, currentAssets <= 0 && model.currentLiabilities <= 0),
    ratio("cashRatio", "Liquidez", "Prueba acida de caja", model.currentLiabilities > 0 ? quickAssets / model.currentLiabilities : 0, "x", "Muestra que tanto se puede pagar de inmediato con caja y bancos.", 0.5, 1.5, false, quickAssets <= 0 && model.currentLiabilities <= 0),
    ratio("receivableTurnover", "Actividad", "Rotacion de cartera", model.receivables > 0 ? income / model.receivables : 0, "x", "Indica cuantas veces se recupera la cartera frente a las ventas registradas.", 3, 8, false, income <= 0 || model.receivables <= 0),
    ratio("assetTurnover", "Actividad", "Rotacion de activos", assets > 0 ? income / assets : 0, "x", "Evalua que tan eficientemente los activos generan ingresos.", 0.15, 0.45, false, income <= 0 || assets <= 0),
    ratio("debtRatio", "Endeudamiento", "Nivel de endeudamiento", assets > 0 ? (model.totalDebt / assets) * 100 : 0, "%", "Porcentaje de activos financiado con deuda. Menor suele ser mas sano.", 55, 25, true, assets <= 0),
    ratio("debtToEquity", "Endeudamiento", "Deuda / patrimonio", model.equity > 0 ? model.totalDebt / model.equity : 0, "x", "Compara la deuda total contra los recursos propios del negocio.", 1.2, 0.5, true, model.equity <= 0),
    ratio("netMargin", "Rentabilidad", "Margen neto", income > 0 ? (profit / income) * 100 : 0, "%", "Porcentaje de cada peso vendido que queda como utilidad.", 15, 35, false, income <= 0),
    ratio("roa", "Rentabilidad", "ROA", assets > 0 ? (profit / assets) * 100 : 0, "%", "Rentabilidad generada por todos los activos del gimnasio.", 4, 12, false, assets <= 0),
    ratio("roic", "Inductores de valor", "ROIC", roic, "%", "Retorno sobre el capital invertido. Debe superar el costo de capital.", model.capitalCostRate / 12, model.capitalCostRate / 4, false, investedCapital <= 0),
    ratio("eva", "Inductores de valor", "Valor economico agregado", eva, "$", "Utilidad despues de cobrar el costo del capital usado por el negocio.", 0, Math.max(income * 0.15, 1), false, investedCapital <= 0 && income <= 0)
  ];
}

function ratio(key, group, name, raw, suffix, description, caution, good, reverse = false, noData = false) {
  if (noData) return { key, group, name, raw: 0, value: "Sin datos", description, score: 0, status: "Sin datos" };
  const value = suffix === "$" ? money(raw) : `${Number(raw || 0).toFixed(suffix === "x" ? 2 : 1)}${suffix}`;
  const bounded = reverse
    ? Math.max(0, Math.min(100, 100 - ((raw - good) / Math.max(caution - good, 1)) * 100))
    : Math.max(0, Math.min(100, ((raw - caution) / Math.max(good - caution, 1)) * 100));
  return { key, group, name, raw, value, description, score: Math.round(bounded), status: bounded >= 70 ? "Fuerte" : bounded >= 40 ? "Vigilar" : "Critico" };
}

function indicatorCard(item) {
  return `
    <article class="indicator-card">
      <div class="indicator-top">
        <span class="badge ${item.status === "Fuerte" ? "online" : item.status === "Vigilar" ? "warn" : "bad"}">${item.group}</span>
        <span>${item.status}</span>
      </div>
      <strong>${item.name}</strong>
      <div class="indicator-value">${item.value}</div>
      <div class="score-track"><i style="width:${item.score}%"></i></div>
      <p>${item.description}</p>
    </article>`;
}

function financeInput(name, label, value, step = 1000) {
  const readonly = name === "fixedAssets" ? "readonly" : "";
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="number" step="${step}" value="${Math.round(value)}" ${readonly} required /></div>`;
}

function messagingScreen() {
  const birthday = state.members.filter((m) => m.birthday?.slice(5) === todayISO.slice(5));
  return `
    ${head("El Aullido", `<span class="status-pill warn">Mensajeria controlada</span>`)}
    <div class="grid">
      <section class="card span-6">
        <h2 class="card-title">Cumpleanos por aprobar</h2>
        <div class="list">
          ${birthday.map((m) => `<div class="list-item"><strong>${m.name}</strong><span>${m.phone}</span><button class="primary-btn" data-approve="${m.id}">Aprobar mensaje</button></div>`).join("") || `<div class="empty">No hay cumpleanos pendientes hoy.</div>`}
        </div>
      </section>
      <section class="card span-6">
        <h2 class="card-title">Campanas</h2>
        <div class="list">
          ${state.campaigns.map((c) => `<div class="list-item"><strong>${c.name}</strong><span>${c.status} · ${c.audience}</span><small>${c.text}</small></div>`).join("")}
        </div>
      </section>
      <section class="card span-12">
        <h2 class="card-title">Nueva campana</h2>
        <form id="campaignForm" class="form-grid">
          <div class="field"><label for="campaignName">Nombre</label><input id="campaignName" name="name" required /></div>
          <div class="field"><label for="campaignAudience">Audiencia</label><input id="campaignAudience" name="audience" placeholder="Ej. Miembros activos" required /></div>
          <div class="field full"><label for="campaignText">Mensaje</label><textarea id="campaignText" name="text" required></textarea></div>
          <div class="actions field full"><button class="primary-btn">Guardar campana</button></div>
        </form>
      </section>
    </div>`;
}


function settingsScreen() {
  return `
    ${head("Configuracion", `<button class="secondary-btn" id="exportUsers">Exportar usuarios Excel</button>`)}
    <div class="grid">
      <section class="card span-4">
        <h2 class="card-title">Perfiles y roles</h2>
        <div class="list">
          <div class="list-item"><strong>Alfa</strong>Gerencia, reportes, auditoria y autorizaciones.</div>
          <div class="list-item"><strong>Cachorro</strong>Registros operativos y consulta basica.</div>
        </div>
      </section>
      <section class="card span-4">
        <h2 class="card-title">Anti-spam</h2>
        <label for="spamLimit">Maximo de mensajes automaticos por mes</label>
        <input id="spamLimit" type="number" min="1" max="12" value="4" />
        <div class="actions"><button class="primary-btn" id="saveConfig">Guardar configuracion</button></div>
      </section>
      <section class="card span-4">
        <h2 class="card-title">Codigos de borrado</h2>
        <p style="color:var(--muted)">Genera un codigo temporal para que recepcion pueda borrar un movimiento registrado por error. Vence en 5 minutos.</p>
        <div class="actions"><button class="primary-btn" id="generateDeleteCode">Generar codigo</button></div>
        <div class="list">
          ${activeDeleteCodes().map((code) => `<div class="list-item"><strong>${code.code}</strong><span>Vence: ${new Date(code.expiresAt).toLocaleTimeString("es-CO")}</span></div>`).join("") || `<div class="empty">No hay codigos activos.</div>`}
        </div>
      </section>
      <section class="card span-4">
        <h2 class="card-title">Herramientas</h2>
        <div class="list">
          ${quick("audit", "audit", "Log de auditoria")}
          ${quick("catalog", "catalog", "Catalogo")}
          ${quick("messaging", "messaging", "El Aullido")}
          ${quick("fang", "fang", "Clave de colmillo")}
        </div>
      </section>
      <section class="card span-12">
        <h2 class="card-title">Usuarios del sistema</h2>
        <div class="product-grid">
          ${state.users.map((user) => `
            <article class="product-card">
              <span class="badge ${user.status === "Activo" ? "online" : "bad"}">${user.status}</span>
              <strong>${user.displayName || user.name}</strong>
              <p>Rol: ${roleName(user.role)}<br>Contrasena: ******<br>Creado: ${user.createdAt || "Demo"}</p>
              <div class="actions">
                <button class="secondary-btn" data-reset-pin="${user.id}">Cambiar contrasena</button>
                <button class="danger-btn" data-delete-user="${user.id}">Eliminar</button>
              </div>
            </article>`).join("")}
        </div>
      </section>
      <section class="card span-12">
        <h2 class="card-title">Crear usuario</h2>
        <form id="userForm" class="form-grid">
          <div class="field"><label for="userName">Nombre</label><input id="userName" name="name" required /></div>
          <div class="field"><label for="userRole">Rol</label><select id="userRole" name="role"><option value="alfa">Administrativo</option><option value="cachorro">Operativo</option></select></div>
          <div class="field"><label for="userPin">Contrasena</label><input id="userPin" name="pin" minlength="4" required /></div>
          <div class="actions field full"><button class="primary-btn">Crear usuario</button></div>
        </form>
      </section>
    </div>`;
}

function roleName(role) {
  return role === "alfa" ? "Administrativo" : "Operativo";
}

function auditScreen() {
  if (state.session.role !== "alfa") return `${head("Acceso restringido")}<div class="empty">Solo el perfil Alfa puede ver auditoria.</div>`;
  const deletedMovements = [
    ...state.incomes.map((item) => ({ ...item, kind: "Ingreso" })),
    ...state.expenses.map((item) => ({ ...item, kind: "Gasto" }))
  ].filter((item) => item.deletedAt);
  const deletedMembers = state.members.filter((m) => m.deletedAt);
  return `
    ${head("Log de auditoria", `<button class="secondary-btn" id="exportAudit">Exportar log</button>`)}
    <section class="card">
      <div class="list">
        ${state.audit.map((a) => `<div class="list-item"><strong>${a.at} · ${a.user} (${a.role})</strong><span>${a.action}</span><small>${a.detail}</small></div>`).join("") || `<div class="empty">Todavia no hay eventos.</div>`}
      </div>
    </section>
    <section class="card" style="margin-top:16px">
      <h2 class="card-title">Movimientos anulados conservados</h2>
      <div class="list">
        ${deletedMovements.map((item) => `<div class="list-item"><strong>${item.kind}: ${item.name}</strong><span>${item.date} · ${money(item.amount)} · Registrado por ${item.user}</span><small>Anulado por ${item.deletedBy} el ${item.deletedAt}. Autorizacion: ${item.deleteAuthorization}. Codigo: ${item.deleteCodeUsed}. Motivo: ${item.deleteReason || "No indicado"}.</small></div>`).join("") || `<div class="empty">No hay movimientos anulados.</div>`}
      </div>
    </section>
    <section class="card" style="margin-top:16px">
      <h2 class="card-title">Miembros eliminados conservados</h2>
      <div class="list">
        ${deletedMembers.map((m) => `<div class="list-item"><strong>${m.name}</strong><span>CC: ${m.doc} | Tel: ${m.phone}</span><small>Eliminado por ${m.deletedBy} el ${m.deletedAt}. Autorizacion: ${m.deleteAuthorization}. Motivo: ${m.deleteReason || "No indicado"}.</small></div>`).join("") || `<div class="empty">No hay miembros eliminados.</div>`}
      </div>
    </section>`;
}

function reportScreen() {
  syncAssetValues();
  const period = state.reportPeriod || "mensual";
  const total = periodTotals(period);
  const topIncome = periodItems(state.incomes, period).sort((a, b) => b.amount - a.amount).slice(0, 3);
  const topExpense = periodItems(state.expenses, period).sort((a, b) => b.amount - a.amount).slice(0, 3);
  const depreciation = depreciationForPeriod(period);
  const netAfterDepreciation = total.profit - depreciation;
  return `
    ${head("Informe financiero", `<button class="primary-btn" id="downloadReport">Descargar reporte</button>`)}
    <div class="grid">
      <section class="card span-12">
        <h2 class="card-title">Strongwolf Training Center</h2>
        <div class="tabs">
          ${["semanal", "mensual", "anual"].map((item) => `<button class="tab ${period === item ? "active" : ""}" data-report-period="${item}">${item}</button>`).join("")}
        </div>
        <p>Informe ${period} generado el ${new Date().toLocaleDateString("es-CO")}.</p>
      </section>
      ${metricCard("Ingresos totales", total.income, "Periodo actual", "span-4")}
      ${metricCard("Gastos totales", total.expense, "Periodo actual", "span-4 expense")}
      ${metricCard("Depreciacion activos", depreciation, "Calculada diaria", "span-4 expense")}
      ${metricCard("Utilidad operativa", total.profit, "Antes de depreciacion", "span-4 profit")}
      ${metricCard("Utilidad neta real", netAfterDepreciation, "Despues de depreciacion", "span-4 profit")}
      ${metricCard("Valor real activos", state.financeModel.fixedAssets, "Hoy", "span-4")}
      <section class="card span-6"><h2 class="card-title">Top ingresos</h2>${rankList(topIncome)}</section>
      <section class="card span-6"><h2 class="card-title">Top gastos</h2>${rankList(topExpense)}</section>
      <section class="card span-12"><h2 class="card-title">Depreciacion por activo</h2>${assetDepreciationReport()}</section>
      <section class="card span-12"><h2 class="card-title">Grafico comparativo</h2>${chart()}</section>
    </div>`;
}

function periodStart(period) {
  const date = new Date(`${todayISO}T00:00:00`);
  if (period === "semanal") date.setDate(date.getDate() - 6);
  else if (period === "anual") date.setFullYear(date.getFullYear() - 1);
  else date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 10);
}

function periodItems(items, period) {
  const start = periodStart(period);
  return activeMovements(items).filter((item) => item.date >= start && item.date <= todayISO);
}

function periodTotals(period) {
  const income = periodItems(state.incomes, period).reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = periodItems(state.expenses, period).reduce((sum, item) => sum + Number(item.amount), 0);
  return { income, expense, profit: income - expense };
}

function assetDepreciationReport() {
  if (!state.assets.length) return `<div class="empty">Sin activos fijos registrados.</div>`;
  return `<div class="list">${state.assets.map((asset) => {
    const dep = assetDepreciation(asset);
    return `<div class="list-item"><strong>${asset.name}</strong><span>${dep.type.label} | Valor real: ${money(dep.currentValue)} | Diario: ${money(dep.daily)} | Acumulada: ${money(dep.accumulated)}</span></div>`;
  }).join("")}</div>`;
}

function rankList(items) {
  return `<div class="list">${items.map((item, index) => `<div class="list-item"><strong>${index + 1}. ${item.name}</strong>${money(item.amount)}</div>`).join("")}</div>`;
}

function catalogScreen() {
  if (!isAlfa() && state.catalogTab === "servicios") state.catalogTab = "productos";
  const list = state.catalogTab === "servicios" ? state.services : state.products;
  return `
    ${head("Catalogo")}
    <section class="card">
      <div class="tabs">
        ${isAlfa() ? `<button class="tab ${state.catalogTab === "servicios" ? "active" : ""}" data-catalog-tab="servicios">Servicios</button>` : ""}
        <button class="tab ${state.catalogTab === "productos" ? "active" : ""}" data-catalog-tab="productos">Productos</button>
      </div>
      <div class="product-grid">${list.map((item) => state.catalogTab === "productos" ? productCard(item) : serviceCard(item)).join("")}</div>
    </section>
    ${isAlfa() ? `<section class="card" style="margin-top:16px">
      <h2 class="card-title">Nuevo item</h2>
      <form id="catalogForm" class="form-grid">
        <div class="field"><label for="catalogType">Tipo</label><select id="catalogType" name="type"><option value="servicio">Servicio</option><option value="producto">Producto</option></select></div>
        <div class="field"><label for="catalogName">Nombre</label><input id="catalogName" name="name" required /></div>
        <div class="field"><label for="catalogPrice">Precio</label><input id="catalogPrice" name="price" type="number" min="0" required /></div>
        <div class="field"><label for="catalogStock">Stock inicial</label><input id="catalogStock" name="stock" type="number" min="0" value="0" /></div>
        <div class="field"><label for="catalogDuration">Duracion dias</label><input id="catalogDuration" name="durationDays" type="number" min="1" value="30" /></div>
        <div class="field"><label for="catalogEntries">Entradas incluidas</label><input id="catalogEntries" name="entries" type="number" min="0" value="0" /></div>
        <div class="actions field full"><button class="primary-btn">Guardar item</button></div>
      </form>
    </section>` : ""}`;
}

function fangScreen(reason = "Accion sensible") {
  return `
    ${head("Clave de colmillo")}
    <section class="card">
      <p class="badge warn">Accion restringida</p>
      <h2>Autorizacion de Gerente Alfa</h2>
      <p>Se requiere PIN de autorizacion para: <strong id="fangReason">${reason}</strong>.</p>
      <div class="pin-dots">${Array.from({ length: 6 }, () => `<div class="pin-dot"></div>`).join("")}</div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map((n) => `<button class="key" data-fang-key="${n}">${n}</button>`).join("")}
        <button class="key" data-fang-key="back">Borrar</button>
        <button class="key" data-fang-key="0">0</button>
        <button class="key confirm" data-fang-key="enter">Autorizar</button>
      </div>
    </section>`;
}

document.addEventListener("input", (event) => {
  if (event.target.id === "memberSearch") {
    state.memberQuery = event.target.value;
    clearTimeout(memberSearchTimer);
    memberSearchTimer = setTimeout(() => {
      const grid = document.querySelector(".member-grid");
      if (grid) {
        syncMemberStatuses();
        const query = state.memberQuery.toLowerCase();
        const filtered = state.members.filter((m) => {
          if (m.deletedAt) return false;
          const matches = `${m.name} ${m.doc} ${m.phone}`.toLowerCase().includes(query);
          const status = state.memberFilter === "todos" || (state.memberFilter === "activos" ? m.active : !m.active);
          return matches && status;
        });
        grid.innerHTML = filtered.map((m) => `
          <article class="member-card">
            <span class="badge ${m.active ? "online" : "bad"}">${m.active ? "Activo" : "Inactivo"}</span>
            <strong>${m.name}</strong>
            <p>CC: ${m.doc}<br>Tel: ${m.phone}<br>Plan: ${m.plan || "Sin plan"}<br>Vence: ${m.due || "Sin fecha"}<br>Cumple: ${m.birthday}</p>
            ${memberPlanSummary(m)}
            <div class="actions">
              <button class="secondary-btn" data-message="${m.id}">Mensaje</button>
              <button class="secondary-btn" data-renew="${m.id}">Renovar</button>
              <button class="danger-btn" data-delete-member="${m.id}">Eliminar</button>
            </div>
          </article>`).join("") || `<div class="empty">No hay miembros con ese filtro.</div>`;
      } else {
        render();
      }
    }, 220);
  }
  if (event.target.id === "incomeItem") {
    const option = event.target.selectedOptions[0];
    const item = [...state.services, ...state.products].find((entry) => entry.id === event.target.value);
    document.querySelector("#incomeAmount").value = item?.price || option?.dataset.price || "";
    const duration = document.querySelector("#incomeDuration");
    const due = document.querySelector("#incomeDue");
    const entries = document.querySelector("#incomeEntries");
    const mode = document.querySelector("#incomePlanMode");
    if (item?.type === "servicio") {
      duration.value = item.durationDays || 30;
      due.value = addDays(todayISO, Number(duration.value || 30));
      entries.value = item.entries || 0;
      mode.value = item.planType || (item.entries ? "tiketera" : "tiempo");
    }
  }
  if (event.target.id === "incomeDuration") {
    const due = document.querySelector("#incomeDue");
    due.value = addDays(todayISO, Number(event.target.value || 30));
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.filter) {
    state.memberFilter = target.dataset.filter;
    saveState();
    render();
    const search = document.querySelector("#memberSearch");
    if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }
  if (target.dataset.catalogTab) {
    state.catalogTab = target.dataset.catalogTab;
    saveState();
    render();
  }
  if (target.dataset.inventoryTab) {
    state.inventoryTab = target.dataset.inventoryTab;
    saveState();
    render();
  }
  if (target.dataset.reportPeriod) {
    state.reportPeriod = target.dataset.reportPeriod;
    saveState();
    render();
  }
  if (target.dataset.sell) sellProduct(target.dataset.sell);
  if (target.dataset.renew) renewMember(target.dataset.renew);
  if (target.dataset.message) approveMessage(target.dataset.message);
  if (target.dataset.approve) approveMessage(target.dataset.approve);
  if (target.dataset.maintenance) registerMaintenance(target.dataset.maintenance);
  if (target.dataset.fang) openFangModal(target.dataset.fang);
  if (target.id === "quickMember") document.querySelector("#memberName")?.focus();
  if (target.id === "saveConfig") {
    addAudit("Actualizo configuracion anti-spam", "Limite mensual guardado.");
    saveState();
    showToast("Configuracion guardada.");
  }
  if (target.id === "exportAudit") exportAudit();
  if (target.id === "downloadReport") downloadReport();
  if (target.id === "exportUsers") exportUsers();
  if (target.id === "exportMembersExcel") exportMembersExcel();
  if (target.id === "exportMembersPdf") exportMembersPdf();
  if (target.id === "generateDeleteCode") generateDeleteCode();
  if (target.dataset.deleteMember) deleteMember(target.dataset.deleteMember);
  if (target.dataset.deleteUser) deleteUser(target.dataset.deleteUser);
  if (target.dataset.resetPin) resetUserPin(target.dataset.resetPin);
  if (target.dataset.deleteMovement) requestDeleteMovement(target.dataset.deleteMovement);
  if (target.dataset.useTicket) useTicket(target.dataset.useTicket);
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));

  if (form.id === "incomeForm") {
    const selected = [...state.services, ...state.products].find((item) => item.id === data.item);
    const amount = Number(data.amount || selected?.price || 0);
    const member = state.members.find((item) => item.name.toLowerCase() === String(data.member || "").toLowerCase());
    state.incomes.unshift({
      id: crypto.randomUUID(),
      date: todayISO,
      type: data.type,
      name: `${data.member || "Cliente"} - ${selected?.name || "Ingreso"}`,
      amount,
      user: state.session.name
    });
    if (selected?.type === "servicio" && member) {
      const totalEntries = Number(data.entries || selected.entries || 0);
      const planMode = data.planMode || selected.planType || (totalEntries > 0 ? "tiketera" : "tiempo");
      const due = data.due || addDays(todayISO, Number(data.durationDays || selected.durationDays || 30));
      state.activePlans.unshift({
        id: crypto.randomUUID(),
        memberId: member.id,
        serviceId: selected.id,
        serviceName: selected.name,
        start: todayISO,
        due,
        durationDays: Number(data.durationDays || selected.durationDays || 30),
        totalEntries,
        remainingEntries: totalEntries,
        mode: planMode,
        status: "Activo",
        createdBy: state.session.name
      });
      member.plan = selected.name;
      member.due = due;
      member.active = true;
      addAudit("Activo plan de miembro", `${member.name} - ${selected.name}. Vence ${due}${totalEntries ? `, ${totalEntries} entradas` : ""}.`);
    }
    if (selected?.type === "producto") selected.stock = Math.max(0, Number(selected.stock || 0) - 1);
    addAudit("Registro ingreso", `${data.type}: ${money(amount)}`);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Ingreso guardado y dashboard actualizado.");
    setScreen("dashboard");
  }

  if (form.id === "expenseForm") {
    state.expenses.unshift({
      id: crypto.randomUUID(),
      date: todayISO,
      category: data.category,
      name: data.name,
      amount: Number(data.amount),
      user: state.session.name
    });
    addAudit("Registro gasto", `${data.category}: ${money(data.amount)}`);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Gasto guardado.");
    setScreen("dashboard");
  }

  if (form.id === "memberForm") {
    state.members.unshift({
      id: crypto.randomUUID(),
      name: String(data.name || "").trim(),
      doc: String(data.doc || "").trim(),
      phone: String(data.phone || "").trim(),
      plan: "Sin plan",
      due: "",
      birthday: data.birthday || "",
      active: false
    });
    addAudit("Creo nuevo miembro", data.name);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Miembro creado como inactivo hasta registrar un plan.");
    render();
  }

  if (form.id === "campaignForm") {
    state.campaigns.unshift({
      id: crypto.randomUUID(),
      name: data.name,
      audience: data.audience,
      text: data.text,
      status: "Lista"
    });
    addAudit("Creo campana", data.name);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Campana guardada.");
    render();
  }

  if (form.id === "catalogForm") {
    const item = {
      id: crypto.randomUUID(),
      type: data.type,
      name: data.name,
      price: Number(data.price),
      stock: data.type === "producto" ? Number(data.stock || 0) : undefined,
      durationDays: data.type === "servicio" ? Number(data.durationDays || 30) : undefined,
      entries: data.type === "servicio" ? Number(data.entries || 0) : undefined,
      planType: data.type === "servicio" && Number(data.entries || 0) > 0 ? "tiketera" : "tiempo",
      status: "Activo"
    };
    if (data.type === "producto") state.products.unshift(item);
    else state.services.unshift(item);
    addAudit("Creo item de catalogo", `${data.type}: ${data.name}`);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Item guardado en catalogo.");
    render();
  }

  if (form.id === "assetForm") {
    const asset = normalizeAsset({
      id: crypto.randomUUID(),
      name: data.name,
      category: data.category,
      assetType: data.assetType,
      status: data.status,
      originalValue: Number(data.originalValue || 0),
      purchaseDate: data.purchaseDate || todayISO,
      next: data.next
    });
    state.assets.unshift(asset);
    syncAssetValues();
    addAudit("Creo activo fijo", `${asset.name} - ${depreciationType(asset.assetType).label}. Valor compra ${money(asset.originalValue)}.`);
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Activo guardado con depreciacion diaria.");
    render();
  }

  if (form.id === "userForm") {
    if (String(data.pin || "").length < 4) return showToast("La contrasena debe tener minimo 4 caracteres.");
    state.users.unshift({
      id: crypto.randomUUID(),
      name: String(data.name).trim().toLowerCase(),
      displayName: data.name,
      role: data.role,
      pin: data.pin,
      password: data.pin,
      status: "Activo",
      createdAt: todayISO
    });
    addAudit("Creo usuario", `${data.name} - ${roleName(data.role)}`);
    saveState();
    try {
      await saveCloudState({ ...state, pin: "" }, true);
      showToast("Usuario creado y sincronizado con servidor.");
    } catch (err) {
      showToast("⚠ Usuario guardado localmente pero NO en servidor. Verifica conexion a Supabase.");
      console.error("Error guardando usuario en nube:", err);
    }
    render();
  }

  if (form.id === "financeModelForm") {
    Object.keys(state.financeModel).forEach((key) => {
      state.financeModel[key] = Number(data[key] || 0);
    });
    syncAssetValues();
    addAudit("Actualizo modelo financiero", "Supuestos para indicadores.");
    saveState();
    await saveCloudState({ ...state, pin: "" }, true);
    showToast("Indicadores actualizados.");
    render();
  }
});
let fangPin = "";
function openFangModal(reason) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card">${fangScreen(reason).replace(head("Clave de colmillo"), "")}<div class="actions"><button class="danger-btn" id="closeModal">Cancelar accion</button></div></div>`;
  document.body.appendChild(modal);
  fangPin = "";
}

document.addEventListener("click", (event) => {
  const key = event.target.closest("[data-fang-key]")?.dataset.fangKey;
  if (!key) return;
  if (key === "back") fangPin = fangPin.slice(0, -1);
  else if (key === "enter") {
    const alfa = state.users.find((user) => user.role === "alfa" && user.status === "Activo" && (user.password || user.pin) === fangPin);
    if (alfa) {
      addAudit("Autorizo clave de colmillo", document.querySelector("#fangReason")?.textContent || "Accion sensible");
      saveState();
      saveCloudState({ ...state, pin: "" }, true);
      document.querySelector(".modal")?.remove();
      showToast("Accion autorizada por Alfa.");
    } else {
      showToast("PIN de autorizacion incorrecto.");
    }
  } else if (fangPin.length < 6) fangPin += key;
  document.querySelectorAll(".modal .pin-dot, .content .pin-dot").forEach((dot, i) => dot.classList.toggle("filled", fangPin.length > i));
});

document.addEventListener("click", (event) => {
  if (event.target.id === "closeModal") document.querySelector(".modal")?.remove();
});

async function sellProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product || product.stock <= 0) return showToast("No hay stock disponible.");
  product.stock -= 1;
  state.incomes.unshift({
    id: crypto.randomUUID(),
    date: todayISO,
    type: "producto",
    name: `Venta - ${product.name}`,
    amount: product.price,
    user: state.session.name
  });
  addAudit("Vendio producto", `${product.name}: ${money(product.price)}`);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Venta registrada e inventario actualizado.");
  render();
}

async function renewMember(id) {
  const member = state.members.find((m) => m.id === id);
  const service = state.services[0];
  if (!member || !service) return;
  const due = new Date();
  due.setDate(due.getDate() + 30);
  member.active = true;
  member.plan = service.name;
  member.due = due.toISOString().slice(0, 10);
  state.incomes.unshift({
    id: crypto.randomUUID(),
    date: todayISO,
    type: "membresia",
    name: `${member.name} - ${service.name}`,
    amount: service.price,
    user: state.session.name
  });
  addAudit("Renovo membresia", member.name);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Membresia renovada.");
  render();
}

async function approveMessage(id) {
  const member = state.members.find((m) => m.id === id);
  addAudit("Aprobo mensaje", member?.name || "Miembro");
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Mensaje aprobado para envio.");
}

async function registerMaintenance(id) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) return;
  asset.status = "Operativa";
  const next = new Date();
  next.setDate(next.getDate() + 45);
  asset.next = next.toISOString().slice(0, 10);
  addAudit("Registro mantenimiento", asset.name);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Mantenimiento registrado.");
  render();
}

function exportAudit() {
  const deletedMovements = [
    ...state.incomes.map((item) => ({ ...item, kind: "Ingreso" })),
    ...state.expenses.map((item) => ({ ...item, kind: "Gasto" }))
  ].filter((item) => item.deletedAt);
  const deletedMembers = state.members.filter((m) => m.deletedAt);
  const text = [
    "LOG DE AUDITORIA",
    ...state.audit.map((a) => `${a.at} | ${a.user} | ${a.action} | ${a.detail}`),
    "",
    "MOVIMIENTOS ANULADOS CONSERVADOS",
    ...deletedMovements.map((item) => `${item.kind} | ${item.date} | ${item.name} | ${money(item.amount)} | Registrado por ${item.user} | Anulado por ${item.deletedBy} | ${item.deletedAt} | Autorizacion: ${item.deleteAuthorization} | Codigo: ${item.deleteCodeUsed} | Motivo: ${item.deleteReason || "No indicado"}`),
    "",
    "MIEMBROS ELIMINADOS CONSERVADOS",
    ...deletedMembers.map((m) => `${m.name} | CC: ${m.doc} | Tel: ${m.phone} | Eliminado por: ${m.deletedBy} | ${m.deletedAt} | Autorizacion: ${m.deleteAuthorization} | Motivo: ${m.deleteReason || "No indicado"}`)
  ].join("\n");
  download("strongwolf-auditoria.txt", text || "Sin eventos");
}

function exportUsers() {
  const rows = [
    ["id", "nombre", "rol", "estado", "creado"],
    ...state.users.map((user) => [user.id, user.displayName || user.name, roleName(user.role), user.status, user.createdAt || ""])
  ];
  download("strongwolf-usuarios.csv", toCsv(rows), "text/csv;charset=utf-8");
  addAudit("Exporto usuarios", "Archivo CSV compatible con Excel.");
  saveState();
}

function memberExportRows() {
  return [
    ["id", "nombre", "documento", "telefono", "cumpleanos", "estado", "plan_actual", "vence", "planes_activos", "entradas_restantes", "entradas_totales"],
    ...state.members.filter((m) => !m.deletedAt).map((member) => {
      const plans = activePlansForMember(member.id);
      return [
        member.id,
        member.name,
        member.doc,
        member.phone,
        member.birthday || "",
        member.active ? "Activo" : "Inactivo",
        member.plan || "Sin plan",
        member.due || "",
        plans.map((plan) => `${plan.serviceName} (${plan.mode === "tiketera" ? "Fecha y entradas" : "Fecha"})`).join(" | "),
        plans.map((plan) => plan.totalEntries ? `${plan.serviceName}: ${plan.remainingEntries}` : "").filter(Boolean).join(" | "),
        plans.map((plan) => plan.totalEntries ? `${plan.serviceName}: ${plan.totalEntries}` : "").filter(Boolean).join(" | ")
      ];
    })
  ];
}

function exportMembersExcel() {
  download("strongwolf-miembros.csv", toCsv(memberExportRows()), "text/csv;charset=utf-8");
  addAudit("Exporto base de miembros", "Archivo CSV compatible con Excel.");
  saveState();
  showToast("Base de miembros descargada para Excel.");
}

function exportMembersPdf() {
  const rows = memberExportRows();
  const htmlRows = rows.map((row, index) => `<tr>${row.map((cell) => index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`).join("")}</tr>`).join("");
  const win = window.open("", "_blank");
  if (!win) return showToast("Activa ventanas emergentes para generar el PDF.");
  win.document.write(`
    <html><head><title>Base de miembros Strongwolf</title>
    <style>body{font-family:Arial,sans-serif;color:#111}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:6px;text-align:left}th{background:#111;color:#fff}h1{font-size:22px}</style>
    </head><body><h1>Base de miembros Strongwolf</h1><p>Generado: ${new Date().toLocaleString("es-CO")}</p><table>${htmlRows}</table></body></html>`);
  win.document.close();
  win.focus();
  win.print();
  addAudit("Exporto base de miembros", "Vista imprimible para PDF.");
  saveState();
}

function activeDeleteCodes() {
  pruneDeleteCodes();
  return state.deleteCodes.filter((item) => !item.used && item.expiresAt > Date.now());
}

function pruneDeleteCodes() {
  state.deleteCodes = (state.deleteCodes || []).filter((item) => !item.used && item.expiresAt > Date.now());
}

function generateDeleteCode() {
  if (!isAlfa()) return showToast("Solo Alfa puede generar codigos.");
  pruneDeleteCodes();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  state.deleteCodes.unshift({
    id: crypto.randomUUID(),
    code,
    createdBy: state.session.name,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    used: false
  });
  addAudit("Genero codigo de borrado", `Codigo temporal ${code}, vence en 5 minutos.`);
  saveState();
  saveCloudState({ ...state, pin: "" }, true);
  showToast(`Codigo generado: ${code}. Vence en 5 minutos.`);
  render();
}

async function useTicket(planId) {
  const plan = state.activePlans.find((item) => item.id === planId);
  if (!plan) return showToast("Plan no encontrado.");
  const member = state.members.find((item) => item.id === plan.memberId);
  if (planExpired(plan)) {
    plan.status = "Vencido";
    saveState();
    return showToast("La tiketera ya esta vencida.");
  }
  if (Number(plan.remainingEntries) <= 0) return showToast("No quedan entradas disponibles.");
  plan.remainingEntries -= 1;
  state.ticketUses.unshift({
    id: crypto.randomUUID(),
    planId,
    memberId: plan.memberId,
    memberName: member?.name || "Miembro",
    date: todayISO,
    time: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }),
    user: state.session.name
  });
  if (plan.remainingEntries <= 0) {
    plan.status = "Vencido";
    if (member) member.active = false;
  }
  addAudit("Desconto entrada de tiketera", `${member?.name || "Miembro"} - ${plan.serviceName}. Restan ${plan.remainingEntries}/${plan.totalEntries}.`);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Entrada descontada y registrada.");
  render();
}

function requestDeleteMovement(payload) {
  const [collection, id] = payload.split(":");
  const list = collection === "incomes" ? state.incomes : state.expenses;
  const movement = list.find((item) => item.id === id);
  if (!movement) return showToast("Movimiento no encontrado.");
  if (!confirm(`Borrar este movimiento por error?\n${movement.name} - ${money(movement.amount)}`)) return;
  let authorizedBy = state.session.name;
  let codeUsed = "Alfa directo";
  if (!isAlfa()) {
    const code = prompt("Introduce el codigo temporal generado por Alfa. Vence en 5 minutos.");
    if (code === null) return;
    const authCode = activeDeleteCodes().find((item) => item.code === code);
    if (!authCode) return showToast("Codigo invalido o vencido.");
    authCode.used = true;
    authorizedBy = `${state.session.name} con codigo de ${authCode.createdBy}`;
    codeUsed = authCode.code;
  }
  const reason = prompt("Motivo de anulacion para historial", "Ajuste de cuentas / registro por error");
  movement.deletedAt = new Date().toLocaleString("es-CO");
  movement.deletedBy = state.session.name;
  movement.deletedRole = state.session.role;
  movement.deleteAuthorization = authorizedBy;
  movement.deleteCodeUsed = codeUsed;
  movement.deleteReason = reason || "No indicado";
  addAudit("Anulo movimiento", `${movement.name} por ${money(movement.amount)}. Anulado por ${state.session.name}. Autorizacion: ${authorizedBy}. Codigo: ${codeUsed}. Motivo: ${movement.deleteReason}.`);
  saveState();
  saveCloudState({ ...state, pin: "" }, true);
  showToast("Movimiento anulado, excluido de totales y conservado en historial.");
  render();
}

async function deleteMember(id) {
  const member = state.members.find((m) => m.id === id);
  if (!member) return;
  if (!isAlfa()) {
    const code = prompt("Esta accion requiere un codigo de borrado generado por el Administrador.");
    if (code === null) return;
    const authCode = activeDeleteCodes().find((item) => item.code === code);
    if (!authCode) return showToast("Codigo invalido o vencido. Solicita uno nuevo al Administrador.");
    authCode.used = true;
    const reason = prompt("Motivo de eliminacion para auditoria", "Registro duplicado / error de ingreso");
    member.deletedAt = new Date().toLocaleString("es-CO");
    member.deletedBy = state.session.name;
    member.deleteReason = reason || "No indicado";
    member.deleteAuthorization = `Codigo de ${authCode.createdBy}`;
    member.deleteCodeUsed = authCode.code;
    addAudit("Elimino miembro (operativo)", `${member.name} | CC: ${member.doc} | Motivo: ${member.deleteReason} | Autorizo: ${authCode.createdBy} | Codigo: ${authCode.code}`);
  } else {
    if (!confirm(`Eliminar a ${member.name} (CC: ${member.doc})?\nQuedara en auditoria pero no aparecera en la lista.`)) return;
    const reason = prompt("Motivo de eliminacion para auditoria", "Registro duplicado / error de ingreso");
    member.deletedAt = new Date().toLocaleString("es-CO");
    member.deletedBy = state.session.name;
    member.deleteReason = reason || "No indicado";
    member.deleteAuthorization = "Alfa directo";
    addAudit("Elimino miembro (alfa)", `${member.name} | CC: ${member.doc} | Motivo: ${member.deleteReason}`);
  }
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast(`${member.name} eliminado. Registro conservado en auditoria.`);
  render();
}

async function deleteUser(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  if (user.id === state.session.id) return showToast("No puedes eliminar tu propio usuario activo.");
  const activeAlfas = state.users.filter((item) => item.role === "alfa" && item.status === "Activo" && item.id !== id);
  if (user.role === "alfa" && activeAlfas.length === 0) return showToast("Debe quedar al menos un usuario Alfa activo.");
  user.status = "Eliminado";
  addAudit("Elimino usuario", user.name);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Usuario eliminado.");
  render();
}

async function resetUserPin(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  const pin = prompt(`Nueva contrasena para ${user.displayName || user.name}`);
  if (pin === null) return;
  if (pin.length < 4) return showToast("La contrasena debe tener minimo 4 caracteres.");
  user.pin = pin;
  user.password = pin;
  addAudit("Cambio contrasena de usuario", user.displayName || user.name);
  saveState();
  await saveCloudState({ ...state, pin: "" }, true);
  showToast("Contrasena actualizada.");
  render();
}

function downloadReport() {
  syncAssetValues();
  const period = state.reportPeriod || "mensual";
  const total = periodTotals(period);
  const indicators = financialIndicators(total);
  const depreciation = depreciationForPeriod(period);
  const text = [
    "STRONGWOLF TRAINING CENTER",
    `Informe ${period} generado: ${new Date().toLocaleString("es-CO")}`,
    `Ingresos: ${money(total.income)}`,
    `Gastos: ${money(total.expense)}`,
    `Utilidad operativa: ${money(total.profit)}`,
    `Depreciacion activos: ${money(depreciation)}`,
    `Utilidad neta real: ${money(total.profit - depreciation)}`,
    `Valor real activos fijos: ${money(state.financeModel.fixedAssets)}`,
    "",
    "Depreciacion por activo:",
    ...state.assets.map((asset) => {
      const dep = assetDepreciation(asset);
      return `${asset.name} | ${dep.type.label} | Valor compra ${money(asset.originalValue)} | Valor real ${money(dep.currentValue)} | Diario ${money(dep.daily)} | Acumulada ${money(dep.accumulated)}`;
    }),
    "",
    "Indicadores financieros:",
    ...indicators.map((item) => `${item.group} | ${item.name} | ${item.value} | ${item.status} | ${item.description}`),
    "",
    "Movimientos:",
    ...[...periodItems(state.incomes, period), ...periodItems(state.expenses, period)].map((item) => `${item.date} | ${item.name} | ${money(item.amount)}`)
  ].join("\n");
  download(`strongwolf-informe-${period}.txt`, text);
}

function toCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
}

function download(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function pollCloudState() {
  if (!cloudEnabled() || !cloudClient || !cloudHydrated) return;
  const cfg = cloudConfig();
  try {
    const { data, error } = await cloudClient
      .from(cfg.table)
      .select("state, updated_at")
      .eq("id", cfg.rowId)
      .maybeSingle();
    if (error || !data?.state) return;
    const serverTime = new Date(data.updated_at).getTime();
    const lastPollTime = pollCloudState._lastServerTime || 0;
    // Solo actualizar si el servidor cambió desde el ultimo poll
    if (serverTime <= lastPollTime) return;
    pollCloudState._lastServerTime = serverTime;
    const currentSession = state.session;
    const currentScreen = state.active;
    state = mergeWithSeed(data.state);
    if (currentSession && !state.session) state.session = currentSession;
    state.active = currentScreen;
    state._lastSaved = data.updated_at;
    localStorage.setItem(storageKey, JSON.stringify({ ...state, pin: "" }));
    render();
    showToast("↻ Datos actualizados desde otro dispositivo.");
  } catch (err) {
    console.warn("Poll error:", err);
  }
}

initCloudSync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();

// Sincronizacion automatica cada 5 segundos
setInterval(pollCloudState, 5000);
