import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, MESAS_CONFIG, EMPRESAS_GASTO, IVA_REBAJA_DEBITO, IVA_REBAJA_CREDITO, IVA_TASA } from './config.js';

// Inicializar Supabase (antes estaba en el <script type="module"> del HTML)
window.supabase_res = createClient(SUPABASE_URL, SUPABASE_KEY);


/* ═══════════════════════════════════════
   ESTADO GLOBAL
═══════════════════════════════════════ */
let mesasChannel    = null;
let usuarioActual   = null;
let productos       = [];
let drawerOpen      = false;
let currentDiscount = 0;
let mesas           = [];
let mesaSeleccionada = null;
let saveTimeout     = null;
let savingCart      = false;
let ventasCache     = [];
let reportChart     = null;
let activeQuickFilter = null;
let editingProductId  = null;
let mesaEditando      = null;
let cambioMetodo      = "efectivo";
let activeCatFilter   = "todos";
let adminCatFilter    = "todos";
let pagosPorMonto     = { efectivo: "", debito: "", credito: "" };
let modoCobro         = "producto";

Object.defineProperty(window, "carrito", {
  get() { return mesaSeleccionada ? mesaSeleccionada.carrito : []; },
  set(val) { if (mesaSeleccionada) mesaSeleccionada.carrito = val; },
  configurable: true
});

/* ═══════════════════════════════════════
   CONFIGURACIÓN
═══════════════════════════════════════ */
// Categorías dinámicas desde Supabase
let categorias = [];

function getCatMap() {
  return Object.fromEntries(categorias.map(c => [c.slug, c]));
}

/* ═══════════════════════════════════════
   REALTIME
═══════════════════════════════════════ */
// 3. Modificar iniciarRealtimeMesas() — ignorar el evento si viene de un save propio reciente
function iniciarRealtimeMesas() {
  if (mesasChannel) window.supabase_res.removeChannel(mesasChannel);

  mesasChannel = supabase_res
    .channel("mesas-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "mesas" }, payload => {
      const nuevaMesa = mapMesa(payload.new);
      const idx = mesas.findIndex(m => m.id === nuevaMesa.id);
      if (idx !== -1) mesas[idx] = nuevaMesa;
      else mesas.push(nuevaMesa);
      mesas.sort((a, b) => a.numero - b.numero);

      if (mesaSeleccionada && mesaSeleccionada.id === nuevaMesa.id) {
        
        // ← AGREGAR ESTE BLOQUE: si el evento llegó poco después de un save propio,
        //   actualizar solo datos que no sean el carrito (para no pisarlo)
        const esSavePropio = (Date.now() - lastSelfSaveAt) < SELF_SAVE_IGNORE_MS;
        
        if (esSavePropio) {
          // Solo sincronizar nombre/descuento que pudo haber cambiado otro usuario,
          // pero NO tocar el carrito local que es más reciente
          mesaSeleccionada.nombre    = nuevaMesa.nombre;
          mesaSeleccionada.descuento = nuevaMesa.descuento;
          // NO hacer: mesaSeleccionada = mesas.find(...)  ← esto pisaría el carrito local
        } else {
          // Evento de otro dispositivo/usuario: sí sincronizar todo
          mesaSeleccionada = mesas.find(m => m.id === nuevaMesa.id);
          updateTotal();
          if (drawerOpen) renderCartItems();
          applyFilters();
        }
      }
      
      renderMesas();
    })
    .subscribe();
}
function mapMesa(m) {
  return {
    id:           m.id,
    numero:       m.numero,
    nombre:       m.nombre || `Mesa ${m.numero}`,
    carrito:      Array.isArray(m.carrito) ? m.carrito : [],
    descuento:    Number(m.descuento || 0),
    descuentoDesc: "",
    ocupada:      !m.mesa_cerrada
  };
}

/* ═══════════════════════════════════════
   AUTH
═══════════════════════════════════════ */
async function checkSession() {
  const { data } = await window.supabase_res.auth.getSession();
  if (!data.session) return false;

  const { data: usuario } = await window.supabase_res
    .from("usuarios")
    .select("*")
    .eq("auth_user_id", data.session.user.id)
    .single();

  if (!usuario || !usuario.activo) return false;
  usuarioActual = usuario;
  return true;
}

async function doLogin() {
  const email    = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  const errorEl  = document.getElementById("loginError");
  const btn      = document.getElementById("loginBtn");
  errorEl.textContent = "";

  if (!email)    { errorEl.textContent = "Ingresá el email"; return; }
  if (!password) { errorEl.textContent = "Ingresá la contraseña"; return; }

  btn.classList.add("loading");

  try {
    const { data, error } = await window.supabase_res.auth.signInWithPassword({ email, password });

    if (error) {
      errorEl.textContent = "Credenciales inválidas";
      btn.classList.remove("loading");
      return;
    }

    const { data: usuario, error: errorUsuario } = await window.supabase_res
      .from("usuarios")
      .select("*")
      .eq("auth_user_id", data.user.id)
      .single();

    if (errorUsuario || !usuario) { errorEl.textContent = "Usuario sin permisos"; btn.classList.remove("loading"); return; }
    if (!usuario.activo)          { errorEl.textContent = "Usuario inactivo";      btn.classList.remove("loading"); return; }

    usuarioActual = usuario;
    await initMesas();
    iniciarRealtimeMesas();
    await loadUserPreferences();
    await cargarCategorias();
    showMesasScreen();
    cargarProductosSupabase();
    // No quitamos loading: la pantalla cambia y el botón desaparece
  } catch(e) {
    errorEl.textContent = "Error de conexión";
    btn.classList.remove("loading");
  }
}

async function doLogout() {
  if (!confirm("¿Cerrar sesión?")) return;
  await window.supabase_res.auth.signOut();
  usuarioActual    = null;
  mesaSeleccionada = null;
  mesas            = [];
  showLogin();
}

/* ═══════════════════════════════════════
   NAVEGACIÓN DE PANTALLAS
═══════════════════════════════════════ */
function showLogin() {
  document.getElementById("loginScreen").style.display  = "flex";
  document.getElementById("posApp").style.display       = "none";
  document.getElementById("mesasScreen").style.display  = "none";
  document.getElementById("loginUser").value  = "";
  document.getElementById("loginPass").value  = "";
  document.getElementById("loginError").textContent = "";
  document.getElementById("loginBtn")?.classList.remove("loading");
}

function showPOS() {
  document.getElementById("loginScreen").style.display = "none";
  const posApp = document.getElementById("posApp");
  posApp.style.display       = "flex";
  posApp.style.flexDirection = "column";
  posApp.style.height        = "100%";
  if (typeof pushNavState === "function") pushNavState();
}

function showMesasScreen() {
  document.getElementById("usuarioHeader").textContent =
    usuarioActual?.username + " | " + usuarioActual?.rol || "";

  document.getElementById("adminMenuWrap").style.display = "block";
  // Mostrar opciones de admin solo si es administrador
  const adminOnlyItems = document.querySelectorAll(".admin-menu-item[data-arg]");
  adminOnlyItems.forEach(el => {
    el.style.display = esAdministrador() ? "" : "none";
  });
  const adminSep = document.querySelector(".admin-menu-separator");
  if (adminSep) adminSep.style.display = esAdministrador() ? "" : "none";

  const stateEl = document.getElementById("stateCenter");
  stateEl.style.display = "flex";
  stateEl.innerHTML = '<div class="spinner"></div>';

  mesaSeleccionada = null;
  document.getElementById("loginScreen").style.display   = "none";
  document.getElementById("posApp").style.display        = "none";
  document.getElementById("mesasScreen").style.display   = "flex";
  document.getElementById("reportPanel").classList.remove("open");

  cargarMesasSupabase().then(remotas => {
    if (remotas?.length > 0) {
      mesas = remotas.map(mapMesa).sort((a, b) => a.numero - b.numero);
    }
    renderMesas();
  });
}

/* ═══════════════════════════════════════
   PERMISOS
═══════════════════════════════════════ */
const esAdministrador   = () => usuarioActual?.rol === "administrador";
const esCajero          = () => usuarioActual?.rol === "cajero";
const esMozo            = () => usuarioActual?.rol === "mozo";
const puedeCobrar       = () => esAdministrador() || esCajero();
const puedeEditarProductos = () => esAdministrador();
const puedeVerReportes  = () => esAdministrador();

/* ═══════════════════════════════════════
   SUPABASE — ACCESO A DATOS
═══════════════════════════════════════ */
async function cargarCategorias() {
  try {
    const { data, error } = await window.supabase_res
      .from("categorias").select("*").eq("activo", true).order("orden");
    if (error) {
      // Si la tabla no existe todavía, solo loguear y seguir — la app funciona sin categorías dinámicas
      console.warn("Categorías no disponibles (¿migraste la tabla?):", error.message);
      return;
    }
    categorias = data;
    renderCatChips();
    renderCatOptions();
  } catch(e) {
    console.warn("Error al cargar categorías:", e);
  }
}

async function cargarProductosSupabase() {
  const { data, error } = await window.supabase_res
    .from("productos")
    .select("*")
    .eq("activo", true)
    .order("categoria")
    .order("nombre");

  if (error) {
    console.error(error);
    showToast("Error cargando productos", "error");
    return [];
  }

  productos = data.sort((a, b) => {
    if (b.cantidad_ventas !== a.cantidad_ventas) return b.cantidad_ventas - a.cantidad_ventas;
    return a.nombre.localeCompare(b.nombre, "es");
  });

  applyFilters();
  localStorage.setItem("productos", JSON.stringify(productos));
  // Si el panel de admin está abierto, refrescar su grilla
  if (document.getElementById("adminProdPanel")?.classList.contains("open")) {
    renderAdminProdGrid();
  }
  return data || [];
}

async function cargarMesasSupabase() {
  const { data, error } = await window.supabase_res
    .from("mesas")
    .select("*")
    .order("numero");

  if (error) {
    console.error(error);
    showToast("Error cargando mesas", "error");
    return [];
  }
  return data || [];
}

async function guardarMesaSupabase(mesa) {
  const subtotal = mesa.carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const descuento = mesa.descuento || 0;
  const total = subtotal - descuento;

  const { error } = await window.supabase_res
    .from("mesas")
    .update({
      carrito:      mesa.carrito,
      subtotal,
      descuento,
      total,
      nombre:       mesa.nombre,
      mesa_cerrada: mesa.carrito.length === 0
    })
    .eq("id", mesa.id);

  if (error) console.error(error);
}

async function guardarVentaSupabase({ mesa, items, subtotal, descuento, total, metodo, pagos }) {
  const { error } = await window.supabase_res
    .from("ventas")
    .insert({ mesa_id: mesa.id, items, subtotal, descuento, total, metodo_pago: metodo, pagos: pagos || null });

  if (error) throw error;
}

/* ═══════════════════════════════════════
   MESAS
═══════════════════════════════════════ */
async function initMesas() {
  const config = (typeof MESAS_CONFIG !== "undefined" && MESAS_CONFIG.length)
    ? MESAS_CONFIG
    : Array.from({ length: 10 }, (_, i) => `Mesa ${i + 1}`);

  const remotas = await cargarMesasSupabase();

  if (remotas?.length > 0) {
    mesas = remotas.map(mapMesa);
    for (let i = 0; i < config.length; i++) {
      const n = i + 1;
      if (!mesas.find(m => m.numero === n)) {
        const nueva = await crearMesaSupabase(n, config[i]);
        if (nueva) mesas.push(nueva);
      }
    }
    mesas.sort((a, b) => a.numero - b.numero);
    return;
  }

  mesas = [];
  for (let i = 0; i < config.length; i++) {
    const nueva = await crearMesaSupabase(i + 1, config[i]);
    mesas.push(nueva || crearMesaLocal(i + 1, config[i]));
  }
}

async function crearMesaSupabase(numero, nombreDefault = "") {
  const { data, error } = await window.supabase_res
    .from("mesas")
    .insert({ numero, nombre: nombreDefault, carrito: [], mesa_cerrada: true })
    .select()
    .single();

  if (error) { console.error("Error creando mesa:", error); return null; }

  return {
    id:           data.id,
    numero:       data.numero,
    nombre:       data.nombre || `Mesa ${data.numero}`,
    carrito:      [],
    descuento:    0,
    descuentoDesc: "",
    ocupada:      false
  };
}

function crearMesaLocal(numero, nombreDefault = "") {
  return { numero, nombre: nombreDefault, carrito: [], ocupada: false, descuento: 0, descuentoDesc: "" };
}

function mesaLabel(mesa) {
  return mesa.nombre || `Mesa ${mesa.numero}`;
}

function saveMesas() {
  if (mesaSeleccionada) {
    guardarMesaSupabase(mesaSeleccionada).catch(e => console.error("Error guardando mesa:", e));
  }
}

function renderMesas() {
  const grid = document.getElementById("mesasGrid");
  grid.innerHTML = "";

  mesas.forEach(mesa => {
    const total  = mesa.carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
    const items  = mesa.carrito.reduce((s, i) => s + i.cantidad, 0);
    const ocupada = mesa.carrito.length > 0;

    const div = document.createElement("div");
    div.className = "mesa-card" + (ocupada ? " ocupada" : "");
    div.innerHTML = `
      <div class="mesa-num">#${mesa.numero}</div>
      <div class="mesa-nombre">${mesaLabel(mesa)}</div>
      <div class="mesa-icon">${ocupada ? "🍽️" : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#22c55e"/></svg>`}</div>
      <div class="mesa-status">${ocupada ? fmt(total) : "Libre"}</div>
      ${items > 0 ? `<div class="mesa-items">${items} ítem${items !== 1 ? "s" : ""}</div>` : ""}
      <div class="edit-hint">mantener = editar</div>
    `;

    let lpTimer = null;
    let didLong = false;

    const startLP = () => {
      didLong = false;
      lpTimer = setTimeout(() => {
        didLong = true;
        navigator.vibrate?.(50);
        abrirNombreModal(mesa);
      }, 550);
    };
    const cancelLP = () => clearTimeout(lpTimer);

    div.addEventListener("touchstart",  startLP,  { passive: true });
    div.addEventListener("touchend",    cancelLP);
    div.addEventListener("touchmove",   cancelLP);
    div.addEventListener("touchcancel", cancelLP);
    div.addEventListener("mousedown",   e => { if (e.button === 0) startLP(); });
    div.addEventListener("mouseup",     cancelLP);
    div.addEventListener("mouseleave",  cancelLP);
    div.addEventListener("contextmenu", e => { e.preventDefault(); cancelLP(); abrirNombreModal(mesa); });
    div.addEventListener("click", () => {
      if (didLong) { didLong = false; return; }
      seleccionarMesa(mesa);
    });

    grid.appendChild(div);
  });

  document.getElementById("stateCenter").style.display = "none";
}

function seleccionarMesa(mesa) {
  mesaSeleccionada = mesa;
  document.getElementById("discount").value     = mesa.descuento     || "";
  document.getElementById("discountDesc").value = mesa.descuentoDesc || "";
  currentDiscount = 0;

  document.getElementById("btnVolverMesas").style.display   = "inline-flex";
  document.getElementById("mesaBadge").style.display        = "block";
  document.getElementById("mesaBadge").textContent          = `🍽️ ${mesaLabel(mesa)}`;
  document.getElementById("drawerMesaBadge").style.display  = "inline-block";
  document.getElementById("drawerMesaBadge").textContent    = mesaLabel(mesa);

  document.getElementById("mesasScreen").style.display = "none";
  const posApp = document.getElementById("posApp");
  posApp.style.display       = "flex";
  posApp.style.flexDirection = "column";
  posApp.style.height        = "100%";

  updateTotal();
  applyFilters();
}

function volverAMesas() {
  if (mesaSeleccionada) {
    mesaSeleccionada.descuento     = parseFloat(document.getElementById("discount").value) || 0;
    mesaSeleccionada.descuentoDesc = document.getElementById("discountDesc").value || "";
    guardarMesaSupabase(mesaSeleccionada).catch(e => console.error("Error guardando mesa al volver:", e));
  }
  closeDrawer();
  showMesasScreen();
}

/* ═══════════════════════════════════════
   NOMBRE DE MESA
═══════════════════════════════════════ */
function abrirNombreModal(mesa) {
  mesaEditando = mesa;
  document.getElementById("nombreModalTitle").textContent = `Nombre — #${mesa.numero}`;
  document.getElementById("nombreModalInput").value = mesa.nombre || "";
  document.getElementById("nombreModalOverlay").classList.add("open");
  setTimeout(() => document.getElementById("nombreModalInput").select(), 150);
}

function cerrarNombreModal() {
  document.getElementById("nombreModalOverlay").classList.remove("open");
  mesaEditando = null;
}

async function guardarNombreMesa() {
  if (!mesaEditando) return;
  const val = document.getElementById("nombreModalInput").value.trim();
  mesaEditando.nombre = val;

  if (mesaEditando.id) {
    const { error } = await window.supabase_res
      .from("mesas")
      .update({ nombre: val })
      .eq("id", mesaEditando.id);
    if (error) console.error("Error guardando nombre de mesa:", error);
  }

  cerrarNombreModal();
  renderMesas();
}

function handleNombreOverlayClick(e) {
  if (e.target === document.getElementById("nombreModalOverlay")) cerrarNombreModal();
}

/* ═══════════════════════════════════════
   PRODUCTOS
═══════════════════════════════════════ */
function getCategoryEmoji(categoria) {
  const cat = getCatMap()[categoria];
  return cat ? cat.emoji : "";
}
function getCategoryColor(categoria) {
  const cat = getCatMap()[categoria];
  return cat ? cat.color : "#94a3b8";
}
function renderCatChips() {
  document.querySelectorAll(".cat-filter-bar").forEach(bar => {
    const isAdmin = bar.id === "adminCatFilterBar";
    bar.innerHTML = "";
    const todos = document.createElement("button");
    todos.className = "cat-chip active";
    if (isAdmin) { todos.dataset.adminCat = "todos"; todos.dataset.action = "setAdminCatFilter"; }
    else         { todos.dataset.cat = "todos";       todos.dataset.action = "setCatFilter"; }
    todos.textContent = "Todos";
    bar.appendChild(todos);
    categorias.filter(c => c.activo).forEach(c => {
      const btn = document.createElement("button");
      btn.className = "cat-chip";
      if (isAdmin) { btn.dataset.adminCat = c.slug; btn.dataset.action = "setAdminCatFilter"; }
      else         { btn.dataset.cat = c.slug;       btn.dataset.action = "setCatFilter"; }
      btn.innerHTML = `<span class="chip-dot" style="background:${c.color}"></span>${c.emoji} ${c.nombre}`;
      bar.appendChild(btn);
    });
  });
  activeCatFilter = "todos";
  adminCatFilter  = "todos";
}
function renderCatOptions(selectedSlug = "") {
  const grid = document.getElementById("categoryOptionsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  categorias.filter(c => c.activo).forEach(c => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="radio" name="prodCategoria" class="cat-option" value="${c.slug}"${c.slug === selectedSlug ? " checked" : ""}><span class="cat-label"><span class="cat-dot" style="background:${c.color}"></span>${c.nombre}</span>`;
    grid.appendChild(label);
  });
}

function setCatFilter(cat, btn) {
  activeCatFilter = cat;
  document.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  applyFilters();
}

function applyFilters() {
  const searchTxt = normalizarTexto(document.getElementById("search").value);
  let lista = productos;

  if (activeCatFilter !== "todos") lista = lista.filter(p => p.categoria === activeCatFilter);
  if (searchTxt) lista = lista.filter(p => normalizarTexto(p.nombre).includes(searchTxt));

  renderProductos(lista);
}

function renderProductos(lista = productos) {
  const stateEl = document.getElementById("stateCenter");
  const grid    = document.getElementById("grid");

  if (lista.length === 0 && productos.length > 0) {
    stateEl.style.display = "flex";
    stateEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><p>No se encontraron productos</p>';
    grid.innerHTML = "";
    return;
  }

  if (lista.length > 0) stateEl.style.display = "none";
  grid.innerHTML = "";

  lista.forEach(p => {
    // Suma todas las líneas del mismo producto (independientemente del método de pago)
    const qty   = carrito.filter(i => i.id === p.id).reduce((s, i) => s + i.cantidad, 0);
    const emoji = getCategoryEmoji(p.categoria);
    const div   = document.createElement("div");
    div.className = "card" + (qty > 0 ? " in-cart" : "");
    div.innerHTML = `
      ${emoji ? `<div class="card-emoji">${emoji}</div>` : ""}
      ${qty > 0 ? `<div class="card-qty">${qty}</div>` : ""}
      <div class="card-lp-ring">
        <svg width="52" height="52" viewBox="0 0 30 30"><circle cx="15" cy="15" r="14"/></svg>
      </div>
      <div class="card-name">${capitalizarTexto(p.nombre)}</div>
      <div class="card-bottom">
        <span class="card-price">${fmt(p.precio)}</span>
        <div class="card-btn">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        </div>
      </div>
    `;

    let lpTimer = null;
    let didLongPress = false;

    const startLongPress = () => {
      didLongPress = false;
      div.classList.add("long-pressing");
      const ring = div.querySelector(".card-lp-ring circle");
      if (ring) { ring.style.animation = "none"; void ring.offsetWidth; ring.style.animation = ""; }
      lpTimer = setTimeout(() => {
        didLongPress = true;
        div.classList.remove("long-pressing");
        navigator.vibrate?.(50);
        if (puedeEditarProductos()) openProductModal(p);
      }, 580);
    };

    const cancelLongPress = () => {
      clearTimeout(lpTimer);
      div.classList.remove("long-pressing");
    };

    div.addEventListener("touchstart",  () => startLongPress(), { passive: true });
    div.addEventListener("touchend",    cancelLongPress);
    div.addEventListener("touchmove",   cancelLongPress);
    div.addEventListener("touchcancel", cancelLongPress);
    div.addEventListener("mousedown",   e => { if (e.button === 0) startLongPress(); });
    div.addEventListener("mouseup",     cancelLongPress);
    div.addEventListener("mouseleave",  cancelLongPress);
    div.addEventListener("contextmenu", e => { e.preventDefault(); cancelLongPress(); if (puedeEditarProductos()) openProductModal(p); });
    div.addEventListener("click", () => {
      if (didLongPress) { didLongPress = false; return; }
      addToCart(p);
    });

    grid.appendChild(div);
  });
}

function recargarProductos() {
  const stateEl = document.getElementById("stateCenter");
  document.getElementById("grid").innerHTML = "";
  stateEl.style.display = "flex";
  stateEl.innerHTML = '<div class="spinner"></div>';
  cargarProductosSupabase(true);
}

/* ═══════════════════════════════════════
   CARRITO
═══════════════════════════════════════ */
function addToCart(prod) {
  // Agrupa por producto + metodo_pago (efectivo por defecto)
  const item = carrito.find(i => i.id === prod.id && i.metodo_pago === "efectivo");
  if (item) item.cantidad++;
  else carrito.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, cantidad: 1, metodo_pago: "efectivo" });

  updateTotal();
  if (drawerOpen) renderCartItems();
  applyFilters();
  saveCart();
  navigator.vibrate?.(20);
}

function changeQty(lineKey, delta) {
  // lineKey = "id:::metodo_pago"
  const [id, metodo] = lineKey.split(":::");
  const idx = carrito.findIndex(i => i.id === id && i.metodo_pago === metodo);
  if (idx === -1) return;
  carrito[idx].cantidad += delta;
  if (carrito[idx].cantidad <= 0) carrito.splice(idx, 1);
  updateTotal();
  renderCartItems();
  applyFilters();
  saveCart();
}

// Cambiar método de pago de una línea: mueve 1 unidad al nuevo método
function cambiarMetodoPago(lineKey, nuevoMetodo) {
  const [id, metodoActual] = lineKey.split(":::");
  if (metodoActual === nuevoMetodo) return;

  const idxOrigen = carrito.findIndex(i => i.id === id && i.metodo_pago === metodoActual);
  if (idxOrigen === -1) return;

  // Restar 1 de la línea origen
  carrito[idxOrigen].cantidad--;
  if (carrito[idxOrigen].cantidad <= 0) carrito.splice(idxOrigen, 1);

  // Buscar línea destino
  const idxDestino = carrito.findIndex(i => i.id === id && i.metodo_pago === nuevoMetodo);
  if (idxDestino !== -1) {
    carrito[idxDestino].cantidad++;
  } else {
    // Encontrar el nombre/precio del producto (desde el item original o del array productos)
    const prod = productos.find(p => p.id === id);
    const nombre = prod ? prod.nombre : (carrito.find(i => i.id === id)?.nombre || "");
    const precio = prod ? prod.precio : (carrito.find(i => i.id === id)?.precio || 0);
    carrito.push({ id, nombre, precio, cantidad: 1, metodo_pago: nuevoMetodo });
  }

  updateTotal();
  renderCartItems();
  applyFilters();
  saveCart();
  navigator.vibrate?.(15);
}

// Cambiar método de pago de TODAS las unidades de un producto específico (long press)
function cambiarMetodoPagoTodos(prodId, nuevoMetodo) {
  if (carrito.length === 0) return;

  const lineasProducto = carrito.filter(i => i.id === prodId);
  if (lineasProducto.length === 0) return;

  const totalCantidad = lineasProducto.reduce((s, i) => s + i.cantidad, 0);
  const ref = lineasProducto[0];

  // Encontrar el índice de la primera línea del producto para insertar ahí
  const primerIdx = carrito.findIndex(i => i.id === prodId);

  // Eliminar todas las líneas del producto
  carrito = carrito.filter(i => i.id !== prodId);

  // Reinsertar en la posición original
  carrito.splice(primerIdx, 0, { id: ref.id, nombre: ref.nombre, precio: ref.precio, cantidad: totalCantidad, metodo_pago: nuevoMetodo });

  updateTotal();
  renderCartItems();
  applyFilters();
  saveCart();
  navigator.vibrate?.([30, 50, 30]);
}

function removeFromCart(lineKey) {
  const [id, metodo] = lineKey.split(":::");
  carrito = carrito.filter(i => !(i.id === id && i.metodo_pago === metodo));
  saveCart();
  updateTotal();
  applyFilters();
  renderCartItems();
}

function clearCart() {
  if (!confirm("¿Vaciar todo el carrito?")) return;
  if (mesaSeleccionada) mesaSeleccionada.carrito = [];
  document.getElementById("discount").value     = "";
  document.getElementById("discountDesc").value = "";
  currentDiscount = 0;
  pagosPorMonto = { efectivo: "", debito: "", credito: "" };
  modoCobro = "producto";
  saveCart();
  updateTotal();
  applyFilters();
  renderCartItems();
  navigator.vibrate?.(30);
}

// 1. Agregar variable de control global (junto al resto de variables globales)
let lastSelfSaveAt = 0;
const SELF_SAVE_IGNORE_MS = 2000; // ignorar eventos Realtime por 2 segundos después de un save propio

// 2. Modificar saveCart() — marcar el timestamp antes de guardar
async function saveCart() {
  if (!mesaSeleccionada) return;
  clearTimeout(saveTimeout);

  saveTimeout = setTimeout(async () => {
    if (savingCart) return;
    savingCart = true;
    lastSelfSaveAt = Date.now(); // ← AGREGAR ESTO

    try {
      const subtotal = carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
      const descuento = parseFloat(document.getElementById("discount").value) || 0;
      const total = subtotal - subtotal * descuento / 100;
      const carritoClonado = JSON.parse(JSON.stringify(carrito));

      const { error } = await window.supabase_res
        .from("mesas")
        .update({
          carrito:      carritoClonado,
          subtotal,
          descuento,
          total,
          mesa_cerrada: carritoClonado.length === 0
        })
        .eq("id", mesaSeleccionada.id);

      if (error) console.error(error);
    } catch (err) {
      console.error(err);
    } finally {
      savingCart = false;
    }
  }, 120);
}

// loadCart: eliminada — el carrito se carga desde Supabase en seleccionarMesa()

/* ═══════════════════════════════════════
   TOTALES Y DRAWER
═══════════════════════════════════════ */
function updateTotal() {
  const subtotal = carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const discPct  = parseFloat(document.getElementById("discount")?.value) || 0;
  currentDiscount = subtotal * Math.min(discPct, 100) / 100;
  const total = subtotal - currentDiscount;

  const el = document.getElementById("totalAmount");
  if (!el) return;
  el.textContent = fmt(total);
  el.classList.toggle("active", total > 0);
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");

  const totalItems = carrito.reduce((s, i) => s + i.cantidad, 0);
  const fab = document.getElementById("fab");
  document.getElementById("fabBadge").textContent = totalItems;
  fab.classList.toggle("hidden", totalItems === 0);

  updatePayButtons();
  updateDrawerTotal();
}

function openDrawer() {
  drawerOpen = true;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("overlay").classList.add("open");
  document.body.style.overflow = "hidden";
  renderCartItems();
  updateDrawerTotal();
  if (typeof pushNavState === "function") pushNavState();
}

function closeDrawer() {
  drawerOpen = false;
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("overlay").classList.remove("open");
  document.body.style.overflow = "";
}

function renderCartItems() {
  const cont = document.getElementById("drawerItems");
  if (carrito.length === 0) {
    cont.innerHTML = `
      <div class="empty-cart">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>
        <p>El carrito está vacío</p>
      </div>`;
    return;
  }

  const METODOS = [
    { key: "efectivo", label: "Efe" },
    { key: "debito",   label: "Déb" },
    { key: "credito",  label: "Cré" },
  ];

  cont.innerHTML = "";

  // Agrupar líneas por producto (mismo id), respetando el orden de primera aparición
  const ordenIds = [];
  const grupos = {};
  carrito.forEach(item => {
    if (!grupos[item.id]) {
      grupos[item.id] = { nombre: item.nombre, precio: item.precio, lineas: [] };
      ordenIds.push(item.id);
    }
    grupos[item.id].lineas.push(item);
  });

  ordenIds.forEach(prodId => {
    const grupo = grupos[prodId];
    const wrapper = document.createElement("div");
    wrapper.className = "cart-group";

    // Determinar método dominante para el acento de color
    const metodos = grupo.lineas.map(l => l.metodo_pago);
    const metodoUnico = metodos.every(m => m === metodos[0]) ? metodos[0] : "mixto";
    wrapper.dataset.metodo = metodoUnico;

    grupo.lineas.forEach((item, idx) => {
      const lineKey = `${item.id}:::${item.metodo_pago}`;
      const esUnica = grupo.lineas.length === 1;
      const div = document.createElement("div");
      div.className = "cart-item" + (idx > 0 ? " cart-item--subline" : "");

      const chipsHtml = modoCobro === "producto" ? METODOS.map(m => `
        <button class="mp-chip${item.metodo_pago === m.key ? " active-" + m.key : ""}"
                data-mp-key="${lineKey}" data-mp-metodo="${m.key}">
          ${m.label}
        </button>`).join("") : `<div class="mp-chips-placeholder">Pago por monto</div>`;

      // Solo la primera línea del grupo muestra nombre y precio unitario
      const infoHtml = idx === 0
        ? `<div class="ci-name">${item.nombre}</div>
           <div class="ci-unit">${fmt(item.precio)} c/u</div>`
        : `<div class="ci-name ci-name--sub">↳ <span class="ci-unit-inline">${fmt(item.precio)} c/u</span></div>`;

      div.innerHTML = `
        <div class="ci-info">
          ${infoHtml}
          <div class="mp-chips">${chipsHtml}</div>
        </div>
        <div class="qty-ctrl">
          <button class="qty-btn" data-qty-id="${lineKey}" data-qty-delta="-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
          </button>
          <span class="qty-val">${item.cantidad}</span>
          <button class="qty-btn" data-qty-id="${lineKey}" data-qty-delta="1">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          </button>
        </div>
        <div class="ci-total">${fmt(item.precio * item.cantidad)}</div>
        <button class="ci-remove" data-remove-id="${lineKey}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      `;
      // Long press en mp-chip → cambia TODOS los productos al método presionado
      if (modoCobro === "producto") {
        div.querySelectorAll(".mp-chip").forEach(chip => {
          let lpTimer = null;
          const LP_DURATION = 500;

          const startLP = () => {
            chip.classList.add("mp-chip--pressing");
            lpTimer = setTimeout(() => {
              chip.classList.remove("mp-chip--pressing");
              cambiarMetodoPagoTodos(prodId, chip.dataset.mpMetodo);
            }, LP_DURATION);
          };
          const cancelLP = () => {
            clearTimeout(lpTimer);
            chip.classList.remove("mp-chip--pressing");
          };

          chip.addEventListener("touchstart",  startLP,  { passive: true });
          chip.addEventListener("touchend",     cancelLP);
          chip.addEventListener("touchcancel",  cancelLP);
          chip.addEventListener("mousedown",    e => { if (e.button === 0) startLP(); });
          chip.addEventListener("mouseup",      cancelLP);
          chip.addEventListener("mouseleave",   cancelLP);
        });
      }

      wrapper.appendChild(div);
    });

    cont.appendChild(wrapper);
  });
}

function updateDrawerTotal() {
  const subtotalEl = document.getElementById("subtotalVal");
  if (!subtotalEl) return;

  const subtotal   = carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
  let discPct      = parseFloat(document.getElementById("discount")?.value) || 0;
  if (discPct < 0)   { discPct = 0;   const inp = document.getElementById("discount"); if (inp) inp.value = 0; }
  if (discPct > 100) { discPct = 100; const inp = document.getElementById("discount"); if (inp) inp.value = 100; }
  const clampedPct = discPct;
  currentDiscount  = subtotal * clampedPct / 100;
  const total      = subtotal - currentDiscount;

  subtotalEl.textContent = fmt(subtotal);
  document.getElementById("cartTotal").textContent = fmt(total);

  const discRow = document.getElementById("discountRow");
  if (currentDiscount > 0) {
    discRow.style.display = "flex";
    document.getElementById("discountLabel").textContent = `Descuento (${clampedPct}%)`;
    document.getElementById("discountVal").textContent   = "-" + fmt(currentDiscount);
  } else {
    discRow.style.display = "none";
  }

  const totalEl = document.getElementById("totalAmount");
  if (totalEl) {
    totalEl.textContent = fmt(total);
    totalEl.classList.toggle("active", total > 0);
  }

  actualizarResumenPagos(total);
}

function calcularPagosPorProducto(total) {
  const bruto = {
    efectivo: carrito.filter(i => i.metodo_pago === "efectivo").reduce((s, i) => s + i.precio * i.cantidad, 0),
    debito:   carrito.filter(i => i.metodo_pago === "debito").reduce((s, i) => s + i.precio * i.cantidad, 0),
    credito:  carrito.filter(i => i.metodo_pago === "credito").reduce((s, i) => s + i.precio * i.cantidad, 0),
  };
  const subtotal = bruto.efectivo + bruto.debito + bruto.credito;
  if (subtotal > 0 && currentDiscount > 0) {
    for (const k of Object.keys(bruto)) bruto[k] = Math.max(0, bruto[k] - (currentDiscount * bruto[k] / subtotal));
  }
  const suma = bruto.efectivo + bruto.debito + bruto.credito;
  if (Math.round(suma) !== Math.round(total)) bruto.efectivo += total - suma;
  return bruto;
}

function pagosPorMontoActivos() {
  return modoCobro === "monto";
}

function calcularPagosManual() {
  return {
    efectivo: parseFloat(pagosPorMonto.efectivo) || 0,
    debito:   parseFloat(pagosPorMonto.debito)   || 0,
    credito:  parseFloat(pagosPorMonto.credito)  || 0,
  };
}

function getPagosFinales(total) {
  if (pagosPorMontoActivos()) return calcularPagosManual();
  return calcularPagosPorProducto(total);
}

function totalPagosManual() {
  const p = calcularPagosManual();
  return p.efectivo + p.debito + p.credito;
}
function setModoCobro(modo) {
  modoCobro = modo === "monto" ? "monto" : "producto";
  if (modoCobro === "monto" && !["efectivo", "debito", "credito"].some(k => pagosPorMonto[k] !== "")) {
    const total = calcularTotalActual();
    const p = calcularPagosPorProducto(total);
    pagosPorMonto = {
      efectivo: p.efectivo ? String(Math.round(p.efectivo)) : "",
      debito:   p.debito   ? String(Math.round(p.debito))   : "",
      credito:  p.credito  ? String(Math.round(p.credito))  : "",
    };
  }
  renderCartItems();
  actualizarResumenPagos(calcularTotalActual());
}


function limpiarPagosPorMonto() {
  pagosPorMonto = { efectivo: "", debito: "", credito: "" };
  modoCobro = "producto";
  renderCartItems();
  actualizarResumenPagos(calcularTotalActual());
}

function actualizarEstadoPagosMonto(total) {
  const estado = document.getElementById("pagoMontoEstado");
  if (!estado) return;
  const suma = totalPagosManual();
  const dif  = total - suma;
  if (modoCobro !== "monto") {
    estado.textContent = "";
    estado.className = "pago-monto-estado";
  } else if (Math.abs(dif) < 0.01) {
    estado.textContent = "Los montos coinciden con el total.";
    estado.className = "pago-monto-estado ok";
  } else if (dif > 0) {
    estado.textContent = `Falta asignar ${fmt(dif)}.`;
    estado.className = "pago-monto-estado warn";
  } else {
    estado.textContent = `Te pasaste por ${fmt(Math.abs(dif))}.`;
    estado.className = "pago-monto-estado error";
  }
}

function actualizarResumenPagos(total) {
  const resumenEl = document.getElementById("pagoResumen");
  if (!resumenEl) return;
  if (carrito.length === 0) { resumenEl.style.display = "none"; return; }

  const calcQty = (metodo) => carrito.filter(i => i.metodo_pago === metodo).reduce((s, i) => s + i.cantidad, 0);
  const pagosProducto = calcularPagosPorProducto(total);
  const fila = (monto, qty, cls, label) => monto > 0
    ? `<div class="pago-resumen-row"><span class="pr-label ${cls}">${label}</span><span class="pr-qty">${qty} prod.</span><span>${fmt(monto)}</span></div>`
    : "";
  const rows = [
    fila(pagosProducto.efectivo, calcQty("efectivo"), "efe", "Efectivo"),
    fila(pagosProducto.debito,   calcQty("debito"),   "deb", "Débito"),
    fila(pagosProducto.credito,  calcQty("credito"),  "cre", "Crédito"),
  ].filter(Boolean).join("");

  const modoMonto = modoCobro === "monto";
  resumenEl.innerHTML = `
    <div class="modo-cobro-bar">
      <span class="modo-cobro-title">Modo de cobro</span>
      <div class="modo-cobro-toggle" role="group" aria-label="Modo de cobro">
        <button type="button" class="modo-cobro-btn${!modoMonto ? ' active' : ''}" data-modo-cobro="producto">Por producto</button>
        <button type="button" class="modo-cobro-btn${modoMonto ? ' active' : ''}" data-modo-cobro="monto">Por monto</button>
      </div>
    </div>
    ${!modoMonto ? `
      <div class="pago-resumen-compact">
        ${rows || '<div class="pago-resumen-row"><span>Sin pagos asignados</span></div>'}
      </div>` : `
      <div class="pago-monto-box is-open">
        <div class="pago-monto-grid">
          <label><span>Efectivo</span><input class="pago-monto-input" data-pago-monto="efectivo" type="number" min="0" step="1" placeholder="0" value="${pagosPorMonto.efectivo}"></label>
          <label><span>Débito</span><input class="pago-monto-input" data-pago-monto="debito" type="number" min="0" step="1" placeholder="0" value="${pagosPorMonto.debito}"></label>
          <label><span>Crédito</span><input class="pago-monto-input" data-pago-monto="credito" type="number" min="0" step="1" placeholder="0" value="${pagosPorMonto.credito}"></label>
        </div>
        <div id="pagoMontoEstado" class="pago-monto-estado"></div>
      </div>`}
  `;
  resumenEl.style.display = "block";
  actualizarEstadoPagosMonto(total);
}

function updatePayButtons() {
  const disabled = carrito.length === 0 || !puedeCobrar();

  // Botón único cobrar
  const btnCobrar = document.getElementById("btnCobrar");
  if (btnCobrar) {
    btnCobrar.disabled     = disabled;
    btnCobrar.style.display = puedeCobrar() ? "inline-flex" : "none";
  }

  // Mantener compatibilidad con los botones individuales si existen
  ["btnEfectivo", "btnDebito", "btnCredito"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled      = disabled;
    el.style.display = "none"; // Ocultamos los botones individuales
  });

  const clearBtn = document.getElementById("clearBtn");
  if (clearBtn) clearBtn.disabled = carrito.length === 0;
}

/* ═══════════════════════════════════════
   CALCULADORA DE VUELTO
═══════════════════════════════════════ */
function calcularTotalActual() {
  return carrito.reduce((s, i) => s + i.precio * i.cantidad, 0) - currentDiscount;
}

function abrirCambio(metodo) {
  if (!puedeCobrar()) { showToast("No tienes permisos", "error"); return; }
  if (carrito.length === 0) return;
  cambioMetodo = metodo;

  const total = calcularTotalActual();
  document.getElementById("cambioTotalVal").textContent  = fmt(total);
  document.getElementById("cambioMonto").value           = "";
  document.getElementById("cambioResultVal").textContent = "—";
  document.getElementById("cambioResultVal").className   = "cambio-result-val";
  document.getElementById("cambioPagarBtn").disabled     = true;

  const quickBtns = document.getElementById("cambioQuickBtns");
  const redondeos = generarRedondeos(total);

  quickBtns.innerHTML = redondeos.map(v =>
    `<button class="cambio-quick-btn" data-monto="${v}">${fmt(v)}</button>`
  ).join("");

  if (redondeos.length > 0) {
    setMontoRapido(redondeos[0]);
    quickBtns.querySelectorAll(".cambio-quick-btn")[0]?.classList.add("active");
  }

  document.getElementById("cambioModalOverlay").classList.add("open");
  setTimeout(() => document.getElementById("cambioMonto").focus(), 200);
}

function generarRedondeos(total) {
  const redondeos = [];
  for (const b of [100, 200, 500, 1000, 2000, 5000, 10000]) {
    const r = Math.ceil(total / b) * b;
    if (!redondeos.includes(r) && redondeos.length < 6) redondeos.push(r);
  }
  return redondeos.slice(0, 6);
}

function setMontoRapido(val) {
  document.getElementById("cambioMonto").value = val;
  document.querySelectorAll(".cambio-quick-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".cambio-quick-btn").forEach(b => {
    if (b.textContent === fmt(val)) b.classList.add("active");
  });
  calcularCambio();
}

function calcularCambio() {
  const total    = calcularTotalActual();
  const monto    = parseFloat(document.getElementById("cambioMonto").value) || 0;
  const vuelto   = monto - total;
  const resultEl = document.getElementById("cambioResultVal");
  const pagarBtn = document.getElementById("cambioPagarBtn");

  if (!monto) {
    resultEl.textContent = "—";
    resultEl.className   = "cambio-result-val";
    pagarBtn.disabled    = true;
    return;
  }

  resultEl.textContent = fmt(vuelto);
  resultEl.className   = "cambio-result-val" + (vuelto < 0 ? " negativo" : "");
  pagarBtn.disabled    = vuelto < 0;
}

function cerrarCambio() {
  document.getElementById("cambioModalOverlay").classList.remove("open");
}

function handleCambioOverlayClick(e) {
  if (e.target === document.getElementById("cambioModalOverlay")) cerrarCambio();
}

function confirmarPagoEfectivo() {
  cerrarCambio();
  pagar(cambioMetodo);
}

/* ═══════════════════════════════════════
   PAGO — ver cobrarVenta() más abajo
═══════════════════════════════════════ */

function setPayBtnsDisabled(v) {
  const btnCobrar = document.getElementById("btnCobrar");
  if (btnCobrar) btnCobrar.disabled = v;
  // Compatibilidad
  ["btnEfectivo", "btnDebito", "btnCredito"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = v;
  });
}

function showPayLoader(show) {
  document.getElementById("payLoader").classList.toggle("hidden", !show);
}

/* ═══════════════════════════════════════
   COBRO MIXTO
═══════════════════════════════════════ */
async function cobrarVenta() {
  if (!puedeCobrar()) { showToast("No tienes permisos", "error"); return; }
  if (carrito.length === 0) return;

  const desc  = document.getElementById("discountDesc").value || "Sin descripción";

  // Items con metodo_pago por línea
  const items = carrito.map(i => ({
    nombre:      i.nombre,
    cantidad:    i.cantidad,
    precio:      i.precio,
    subtotal:    i.precio * i.cantidad,
    total:       i.precio * i.cantidad,
    id:          i.id,
    mesa:        mesaSeleccionada.nombre,
    metodo_pago: i.metodo_pago
  }));

  if (currentDiscount > 0) {
    items.push({
      id: "descuento", nombre: "Descuento - " + desc, cantidad: 1,
      precio: -currentDiscount, subtotal: -currentDiscount, total: -currentDiscount,
      mesa: mesaSeleccionada.nombre, metodo_pago: "efectivo"
    });
  }

  const subtotal = carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const total    = subtotal - currentDiscount;

  // Resumen de pagos por método. Si se cargaron montos manuales, tienen prioridad.
  const pagos = getPagosFinales(total);
  const sumaPagos = pagos.efectivo + pagos.debito + pagos.credito;
  if (pagosPorMontoActivos() && Math.abs(sumaPagos - total) > 0.01) {
    showToast(`Los montos de pago deben sumar ${fmt(total)}`, "error");
    return;
  }

  // Determinar metodo_pago principal (el de mayor monto)
  const metodoPrincipal = Object.entries(pagos).reduce((a, b) => b[1] > a[1] ? b : a)[0];

  showPayLoader(true);
  setPayBtnsDisabled(true);

  try {
    await guardarVentaSupabase({ mesa: mesaSeleccionada, items, subtotal, descuento: currentDiscount, total, metodo: metodoPrincipal, pagos });

    const { error: errMesa } = await window.supabase_res
      .from("mesas")
      .update({ carrito: [], subtotal: 0, descuento: 0, total: 0, metodo_pago: metodoPrincipal, mesa_cerrada: true, fecha_cierre: new Date().toISOString() })
      .eq("id", mesaSeleccionada.id);

    if (errMesa) throw errMesa;

    if (mesaSeleccionada) {
      mesaSeleccionada.carrito       = [];
      mesaSeleccionada.descuento     = 0;
      mesaSeleccionada.descuentoDesc = "";
    }
    document.getElementById("discount").value     = "";
    document.getElementById("discountDesc").value = "";
    currentDiscount = 0;
    pagosPorMonto = { efectivo: "", debito: "", credito: "" };
    modoCobro = "producto";
    localStorage.removeItem("carrito");
    updateTotal();
    applyFilters();
    closeDrawer();
    showToast("Pago procesado", "success");
    playSuccessSound();
    setTimeout(() => volverAMesas(), 900);
  } catch (err) {
    console.error("Error al procesar pago:", err);
    showToast("Error al procesar el pago. Intente nuevamente.", "error");
  } finally {
    showPayLoader(false);
    setPayBtnsDisabled(false);
  }
}

// Mantener pagar() como alias para compatibilidad con la calculadora de cambio
async function pagar(metodo) {
  // Reasignar todo el carrito al método indicado antes de cobrar
  carrito.forEach(i => { i.metodo_pago = metodo; });
  await cobrarVenta();
}

/* ═══════════════════════════════════════
   BUSCADOR
═══════════════════════════════════════ */
function handleSearch() {
  const input = document.getElementById("search").value;
  document.getElementById("search-clear").style.display = input ? "block" : "none";
  applyFilters();
}

function clearSearch() {
  document.getElementById("search").value = "";
  document.getElementById("search-clear").style.display = "none";
  applyFilters();
}

/* ═══════════════════════════════════════
   REPORTE
═══════════════════════════════════════ */
function openReport() {
  document.getElementById("reportPanel").classList.add("open");
  if (ventasCache.length === 0) cargarVentas();
  if (typeof pushNavState === "function") pushNavState();
}

function closeReport() {
  document.getElementById("reportPanel").classList.remove("open");
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function setQuickFilter(tipo, btn) {
  document.querySelectorAll(".qf-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  activeQuickFilter = tipo;

  const hoy = new Date();
  let desde = "", hasta = "";

  if (tipo === "hoy") {
    desde = hasta = toDateStr(hoy);
  } else if (tipo === "semana") {
    const lunes = new Date(hoy);
    lunes.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
    desde = toDateStr(lunes);
    hasta = toDateStr(hoy);
  } else if (tipo === "mes") {
    desde = toDateStr(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    hasta = toDateStr(hoy);
  }

  document.getElementById("fechaDesde").value = desde;
  document.getElementById("fechaHasta").value = hasta;
  renderReporte();
}

async function cargarVentas() {
  const content = document.getElementById("reportContent");
  content.innerHTML = `<div class="report-loading"><div class="spinner"></div><span>Cargando ventas...</span></div>`;
  document.getElementById("reportSubtitle").textContent = "Actualizando...";

  try {
    const { data, error } = await window.supabase_res
      .from("ventas")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    ventasCache = [];
    (data || []).forEach(venta => {
      (Array.isArray(venta.items) ? venta.items : []).forEach(item => {
        ventasCache.push({
          fecha: venta.created_at, metodo: venta.metodo_pago,
          nombre: item.nombre, cantidad: item.cantidad,
          precio: item.precio, total: item.total, mesa: item.mesa || "",
          // columna nueva: desglose por método de pago de toda la venta
          pagos: venta.pagos || null,
          ventaTotal: venta.total,
          ventaId: venta.id || (venta.created_at + venta.metodo_pago),
        });
      });
    });

    renderReporte();
  } catch (e) {
    console.error("Error cargando ventas:", e);
    content.innerHTML = `
      <div class="report-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
        <p>No se pudo cargar el reporte.<br>Verificá tu conexión e intentá nuevamente.</p>
      </div>`;
    document.getElementById("reportSubtitle").textContent = "Error al cargar";
  }
}

function aplicarFiltro() {
  document.querySelectorAll(".qf-btn").forEach(b => b.classList.remove("active"));
  activeQuickFilter = null;
  renderReporte();
}

function parseFecha(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = String(val);
  const d = new Date(s);
  if (!isNaN(d)) return d;
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3) {
    return parts[0].length === 4
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return null;
}

function renderReporte() {
  const desde = document.getElementById("fechaDesde").value;
  const hasta = document.getElementById("fechaHasta").value;

  let ventas = ventasCache;
  if (desde || hasta) {
    ventas = ventas.filter(v => {
      const f = parseFecha(v.fecha);
      if (!f) return false;
      const fs = toDateStr(f);
      if (desde && fs < desde) return false;
      if (hasta && fs > hasta) return false;
      return true;
    });
  }

  const ventasProductos = ventas.filter(v => v.total >= 0 && !String(v.nombre).toLowerCase().startsWith("descuento"));
  const content = document.getElementById("reportContent");

  if (ventas.length === 0 && ventasCache.length > 0) {
    content.innerHTML = `<div class="report-empty"><svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><p>No hay ventas en el período seleccionado.</p></div>`;
    updateSubtitle(ventas, desde, hasta);
    return;
  }

  if (ventasCache.length === 0) {
    content.innerHTML = `<div class="report-empty"><svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h2l.4 2"/><path d="M7 13h10l4-8H5.4"/><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/></svg><p>Sin datos de ventas aún.</p></div>`;
    document.getElementById("reportSubtitle").textContent = "Sin ventas registradas";
    return;
  }

  const totalVentas  = ventasProductos.reduce((s, v) => s + (parseFloat(v.total) || 0), 0);

  // Agrupar por venta única para no sumar pagos múltiples veces (una venta = N items)
  const ventasUnicas = new Map();
  ventas.forEach(v => {
    if (!ventasUnicas.has(v.ventaId)) ventasUnicas.set(v.ventaId, v);
  });

  let efectivo = 0, debito = 0, credito = 0;
  ventasUnicas.forEach(v => {
    if (v.pagos && typeof v.pagos === "object") {
      // Venta nueva: usar desglose real por método
      efectivo += Math.max(parseFloat(v.pagos.efectivo) || 0, 0);
      debito   += Math.max(parseFloat(v.pagos.debito)   || 0, 0);
      credito  += Math.max(parseFloat(v.pagos.credito)  || 0, 0);
    } else {
      // Venta vieja: todo al método único registrado
      const monto = Math.max(parseFloat(v.ventaTotal) || 0, 0);
      const m = String(v.metodo || "").toLowerCase();
      if (m === "efectivo")     efectivo += monto;
      else if (m === "debito")  debito   += monto;
      else if (m === "credito") credito  += monto;
      else                      efectivo += monto; // fallback
    }
  });

  const transacciones = ventasUnicas.size;

  // Rebaja IVA ley inclusión financiera (precios con IVA incluido)
  // descuento = total × puntos / (100 + tasa_iva)
  const divisorIVA      = 100 + IVA_TASA;
  const debitoDescuento  = debito  * IVA_REBAJA_DEBITO  / divisorIVA;
  const creditoDescuento = credito * IVA_REBAJA_CREDITO / divisorIVA;
  const debitoNeto       = debito  - debitoDescuento;
  const creditoNeto      = credito - creditoDescuento;

  const prodMap = {};
  ventasProductos.forEach(v => {
    const n = v.nombre || "Desconocido";
    if (!prodMap[n]) prodMap[n] = { cantidad: 0, total: 0 };
    prodMap[n].cantidad += parseInt(v.cantidad) || 0;
    prodMap[n].total    += parseFloat(v.total) || 0;
  });

  const topProductos = Object.entries(prodMap).sort((a, b) => b[1].cantidad - a[1].cantidad).slice(0, 10);

  updateSubtitle(ventas, desde, hasta);

  content.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card green">
        <div class="summary-label">Total vendido</div>
        <div class="summary-value">${fmt(efectivo + debitoNeto + creditoNeto)}</div>
        <div class="summary-sub">cobrado ${fmt(totalVentas)} · <span class="summary-rebaja">−${fmt(debitoDescuento + creditoDescuento)} IVA</span></div>
      </div>
      <div class="summary-card blue"><div class="summary-label">Efectivo</div><div class="summary-value">${fmt(efectivo)}</div></div>
      <div class="summary-card blue">
        <div class="summary-label">Débito <span class="summary-ley-badge">Ley 17.934 · ${IVA_REBAJA_DEBITO} pts IVA</span></div>
        <div class="summary-value">${fmt(debitoNeto)}</div>
        <div class="summary-sub">cobrado ${fmt(debito)} · <span class="summary-rebaja">−${fmt(debitoDescuento)} IVA</span></div>
      </div>
      <div class="summary-card purple">
        <div class="summary-label">Crédito <span class="summary-ley-badge">Ley 17.934 · ${IVA_REBAJA_CREDITO} pts IVA</span></div>
        <div class="summary-value">${fmt(creditoNeto)}</div>
        <div class="summary-sub">cobrado ${fmt(credito)} · <span class="summary-rebaja">−${fmt(creditoDescuento)} IVA</span></div>
      </div>
    </div>
    <div class="chart-card">
      <h3>Productos más vendidos (por unidades)</h3>
      <div class="chart-wrap"><canvas id="reportChartCanvas"></canvas></div>
    </div>
    <div class="table-card">
      <h3>Ventas agrupadas (${ventasUnicas.size} transacciones)</h3>
      <div id="ventasGrupoContainer"></div>
    </div>
  `;

  renderChart(topProductos);
  renderVentasAgrupadas(ventas);
}

function renderVentasAgrupadas(ventas) {
  const container = document.getElementById("ventasGrupoContainer");
  if (!container) return;

  if (ventas.length === 0) {
    container.innerHTML = `<div class="report-empty"><p>Sin registros.</p></div>`;
    return;
  }

  const grupos = {};
  ventas.forEach(v => {
    const fecha    = parseFecha(v.fecha);
    const fechaStr = fecha
      ? fecha.toLocaleDateString("es-UY", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : (v.fecha || "?");
    const clave = v.ventaId || (v.fecha + "___" + v.metodo);
    if (!grupos[clave]) grupos[clave] = { fechaStr, fecha: v.fecha, metodo: v.metodo, pagos: v.pagos || null, ventaTotal: v.ventaTotal, items: [], total: 0 };
    grupos[clave].items.push(v);
    grupos[clave].total += parseFloat(v.total) || 0;
  });

  const gruposArr = Object.values(grupos).sort((a, b) => {
    return (parseFecha(b.fecha) || 0) - (parseFecha(a.fecha) || 0);
  });

  const visible = gruposArr.slice(0, 100);
  container.innerHTML = visible.map((g, idx) => {
    const metodo     = String(g.metodo || "").toLowerCase();
    const esMixto    = g.pagos && typeof g.pagos === "object" &&
                       [g.pagos.efectivo, g.pagos.debito, g.pagos.credito].filter(x => parseFloat(x) > 0).length > 1;

    // Badge de método: si es mixto mostrar los tres métodos activos
    let badgeHtml;
    if (esMixto) {
      const partes = [];
      if (parseFloat(g.pagos.efectivo) > 0) partes.push(`<span class="badge-metodo badge-efectivo">Efe ${fmt(g.pagos.efectivo)}</span>`);
      if (parseFloat(g.pagos.debito)   > 0) partes.push(`<span class="badge-metodo badge-debito">Déb ${fmt(g.pagos.debito)}</span>`);
      if (parseFloat(g.pagos.credito)  > 0) partes.push(`<span class="badge-metodo badge-credito">Cré ${fmt(g.pagos.credito)}</span>`);
      badgeHtml = partes.join(" ");
    } else {
      const badgeClass = metodo === "efectivo" ? "badge-efectivo" : metodo === "debito" ? "badge-debito" : metodo === "credito" ? "badge-credito" : "";
      badgeHtml = `<span class="badge-metodo ${badgeClass}">${g.metodo || "-"}</span>`;
    }

    const itemsHtml  = g.items.map(v => {
      const esDescuento = String(v.nombre).toLowerCase().startsWith("descuento");
      return `<div class="venta-item-row${esDescuento ? " descuento" : ""}">
        <span class="venta-item-nombre">${v.nombre || "-"}</span>
        <span class="venta-item-cant">x${v.cantidad || 1}</span>
        <span class="venta-item-total">${v.total != null ? fmt(parseFloat(v.total)) : "-"}</span>
      </div>`;
    }).join("");

    return `<div class="venta-grupo" id="vg_${idx}">
      <div class="venta-grupo-header" data-grupo-idx="${idx}">
        <div class="venta-grupo-left">
          <div class="venta-grupo-fecha">${g.fechaStr}</div>
          <div class="venta-grupo-meta">${g.items.length} producto${g.items.length !== 1 ? "s" : ""} · ${badgeHtml}</div>
        </div>
        <div class="venta-grupo-right">
          <span class="venta-grupo-total">${fmt(g.total)}</span>
          <svg class="venta-grupo-toggle" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>
      <div class="venta-grupo-items">${itemsHtml}</div>
    </div>`;
  }).join("") + (gruposArr.length > 100 ? `<p style="text-align:center;font-size:12px;color:var(--muted-fg);padding:8px 0">Mostrando 100 de ${gruposArr.length} transacciones</p>` : "");
}

function toggleGrupo(idx) {
  document.getElementById("vg_" + idx)?.classList.toggle("open");
}

function updateSubtitle(ventas, desde, hasta) {
  const sub = document.getElementById("reportSubtitle");
  const transacciones = new Set(ventas.map(v => v.ventaId)).size;
  if (!desde && !hasta)       sub.textContent = `${transacciones} transacciones en total`;
  else if (desde && hasta)    sub.textContent = `${desde} — ${hasta} · ${transacciones} transacciones`;
  else if (desde)             sub.textContent = `Desde ${desde} · ${transacciones} transacciones`;
  else                        sub.textContent = `Hasta ${hasta} · ${transacciones} transacciones`;
}

function renderChart(topProductos) {
  if (reportChart) { reportChart.destroy(); reportChart = null; }
  const canvas = document.getElementById("reportChartCanvas");
  if (!canvas || topProductos.length === 0) return;

  reportChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: topProductos.map(([name]) => name.length > 20 ? name.slice(0, 18) + "…" : name),
      datasets: [{
        label: "Unidades vendidas",
        data: topProductos.map(([, d]) => d.cantidad),
        backgroundColor: ["#2563eb","#10b981","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#ec4899","#84cc16","#f97316","#6366f1"].slice(0, topProductos.length),
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} unidades` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "Inter", size: 11 }, color: "#64748b" } },
        y: { beginAtZero: true, grid: { color: "#e2e8f0" }, ticks: { font: { family: "Inter", size: 11 }, color: "#64748b", stepSize: 1 } }
      }
    }
  });
}

/* ═══════════════════════════════════════
   MODAL PRODUCTO
═══════════════════════════════════════ */
function openProductModal(producto) {
  editingProductId = producto ? producto.id : null;
  const isEdit = !!producto;

  document.getElementById("productModalTitle").textContent = isEdit ? "Editar Producto" : "Agregar Producto";
  document.getElementById("prodId").value          = producto ? producto.id : "";
  document.getElementById("prodNombre").value      = producto ? producto.nombre : "";
  document.getElementById("prodDescripcion").value = producto ? (producto.descripcion || "") : "";
  document.getElementById("prodPrecio").value      = producto ? producto.precio : "";
  renderCatOptions(producto ? producto.categoria : "");

  const mostrarCarta = producto ? (producto.mostrar_carta !== false) : true;
  document.getElementById("prodMostrarCarta").checked = mostrarCarta;
  actualizarTextoToggle(mostrarCarta);

  const mostrarPrecioCarta = producto ? (producto.mostrar_precio_carta !== false) : true;
  document.getElementById("prodMostrarPrecioCarta").checked = mostrarPrecioCarta;
  actualizarTextoTogglePrecio(mostrarPrecioCarta);

  document.getElementById("prodNombre").classList.remove("invalid");
  document.getElementById("prodPrecio").classList.remove("invalid");
  document.getElementById("deleteProductBtn").style.display = isEdit ? "flex" : "none";

  document.getElementById("productModalOverlay").classList.add("open");
  setTimeout(() => document.getElementById("prodNombre").focus(), 320);
  if (typeof pushNavState === "function") pushNavState();
}

function closeProductModal() {
  document.getElementById("productModalOverlay").classList.remove("open");
  editingProductId = null;
}

function handleModalOverlayClick(e) {
  if (e.target === document.getElementById("productModalOverlay")) closeProductModal();
}

async function guardarProducto() {
  const nombre      = document.getElementById("prodNombre").value.trim();
  const descripcion = document.getElementById("prodDescripcion").value.trim();
  const precio      = parseFloat(document.getElementById("prodPrecio").value);
  const categoria   = document.querySelector(".cat-option:checked")?.value || "";
  const mostrar_carta         = document.getElementById("prodMostrarCarta").checked;
  const mostrar_precio_carta  = document.getElementById("prodMostrarPrecioCarta").checked;
  const id = editingProductId;

  let valid = true;

  if (!nombre) { document.getElementById("prodNombre").classList.add("invalid"); valid = false; }
  else          document.getElementById("prodNombre").classList.remove("invalid");

  if (!precio || precio <= 0) { document.getElementById("prodPrecio").classList.add("invalid"); valid = false; }
  else                          document.getElementById("prodPrecio").classList.remove("invalid");

  if (!categoria) { showToast("Seleccioná una categoría.", "error"); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("saveProductBtn");
  btn.disabled = true;
  btn.classList.add("loading");

  try {
    if (id) {
      const { error } = await window.supabase_res
        .from("productos")
        .update({ nombre, descripcion, precio, categoria, mostrar_carta, mostrar_precio_carta })
        .eq("id", id);
      if (error) throw error;
    } else {
      const { error } = await window.supabase_res
        .from("productos")
        .insert({ nombre, descripcion, precio, categoria, activo: true, mostrar_carta, mostrar_precio_carta });
      if (error) throw error;
    }

    showToast((id ? "Producto actualizado: " : "Producto agregado: ") + nombre, "success");
    closeProductModal();
    localStorage.removeItem("productos");
    localStorage.removeItem("productos_timestamp");
    cargarProductosSupabase(true);
  } catch (err) {
    console.error("Error guardando producto:", err);
    showToast("No se pudo guardar el producto. Intentá nuevamente.", "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

async function eliminarProducto() {
  if (!editingProductId) return;
  if (!confirm("¿Eliminar este producto? Esta acción no se puede deshacer.")) return;

  const btn = document.getElementById("saveProductBtn");
  btn.disabled = true;

  try {
    const { error } = await window.supabase_res
      .from("productos")
      .update({ activo: false })
      .eq("id", editingProductId);

    if (error) throw error;

    showToast("Producto eliminado.", "success");
    closeProductModal();
    localStorage.removeItem("productos");
    localStorage.removeItem("productos_timestamp");
    recargarProductos(true);
  } catch (err) {
    console.error("Error eliminando producto:", err);
    showToast("No se pudo eliminar el producto. Intentá nuevamente.", "error");
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════
   MENÚ ADMINISTRADOR
═══════════════════════════════════════ */
function toggleAdminMenu() {
  const menu = document.getElementById("adminMenu");
  const btn  = document.getElementById("adminMenuBtn");
  const open = menu.style.display === "none";
  menu.style.display = open ? "block" : "none";
  btn.setAttribute("aria-expanded", open);
}

function closeAdminMenu() {
  const menu = document.getElementById("adminMenu");
  if (menu) menu.style.display = "none";
  document.getElementById("adminMenuBtn")?.setAttribute("aria-expanded", "false");
}

function adminMenuAction(accion) {
  closeAdminMenu();
  if (accion === "reporte")  openReport();
  if (accion === "producto") openAdminProd();
  if (accion === "gastos")   openGastos();
  if (accion === "reporte-gastos") openGastosReport();
  if (accion === "cruce")          openCruce();
  if (accion === "configuracion")  openConfig();
}

// Cerrar el menú si se hace clic fuera
document.addEventListener("click", function(e) {
  const wrap = document.getElementById("adminMenuWrap");
  if (wrap && !wrap.contains(e.target)) closeAdminMenu();
});

/* ═══════════════════════════════════════
   GASTOS
═══════════════════════════════════════ */
let gastoParseado = null; // objeto JSON parseado listo para guardar

function openGastos() {
  resetGastosPanel();
  document.getElementById("gastosPanel").classList.add("open");
  if (typeof pushNavState === "function") pushNavState();
}

function closeGastos() {
  document.getElementById("gastosPanel").classList.remove("open");
}

function resetGastosPanel() {
  gastoParseado = null;
  document.getElementById("gastosJsonInput").value = "";
  document.getElementById("gastosJsonInput").className = "gastos-json-area";
  document.getElementById("gastosJsonError").textContent = "";
  document.getElementById("gastosJsonError").classList.remove("visible");
  document.getElementById("gastosPreview").style.display = "none";
  document.getElementById("gastosPreviewCard").innerHTML = "";
  // Restaurar botón Guardar por si quedó en estado loading de un guardado anterior
  const confirmBtn = document.getElementById("gastosConfirmBtn");
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Confirmar y guardar`;
  }
  switchGastosTab("json");
}

function switchGastosTab(tab) {
  document.getElementById("gastosTabJson").style.display   = tab === "json"   ? "flex" : "none";
  document.getElementById("gastosTabManual").style.display = tab === "manual" ? "flex" : "none";
  document.getElementById("tabJson").classList.toggle("active",   tab === "json");
  document.getElementById("tabManual").classList.toggle("active", tab === "manual");
  if (tab === "manual") gmInicializar();
}

function onGastosJsonInput() {
  // reset preview y estilos al editar
  gastoParseado = null;
  document.getElementById("gastosPreview").style.display = "none";
  document.getElementById("gastosJsonInput").classList.remove("error", "valid");
  document.getElementById("gastosJsonError").classList.remove("visible");
}

function parsearGastoJson() {
  const raw = document.getElementById("gastosJsonInput").value.trim();
  const errorEl = document.getElementById("gastosJsonError");
  const textarea = document.getElementById("gastosJsonInput");

  errorEl.classList.remove("visible");
  textarea.classList.remove("error", "valid");

  if (!raw) {
    mostrarErrorGasto("Pegá el contenido del JSON antes de continuar.");
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch(e) {
    mostrarErrorGasto("JSON inválido: " + e.message);
    textarea.classList.add("error");
    return;
  }

  // Validaciones mínimas (empresa puede ser null: se completa en la vista previa)
  const camposRequeridos = ["fecha", "total"];
  for (const campo of camposRequeridos) {
    if (data[campo] === undefined || data[campo] === null) {
      mostrarErrorGasto(`El JSON no contiene el campo requerido: "${campo}".`);
      textarea.classList.add("error");
      return;
    }
  }

  textarea.classList.add("valid");
  gastoParseado = data;
  renderGastoPreview(data);
  document.getElementById("gastosPreview").style.display = "flex";
  document.getElementById("gastosPreview").style.flexDirection = "column";
  document.getElementById("gastosPreview").style.gap = "14px";
}

function mostrarErrorGasto(msg) {
  const el = document.getElementById("gastosJsonError");
  el.textContent = msg;
  el.classList.add("visible");
}

function fmtUYU(n) {
  return "$\u00a0" + Number(n).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const RUBROS_GASTO = ["", "Rotisería", "Cafetería", "Limpieza", "Administrativo", "Otros"];
function normalizarRubro(str) {
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function renderGastoPreview(d) {
  const productos = Array.isArray(d.productos) ? d.productos : [];
  const formas    = Array.isArray(d.forma_pago) ? d.forma_pago : [];
  const descuentos= Array.isArray(d.descuentos) ? d.descuentos : [];
  const impuestos = Array.isArray(d.impuestos)  ? d.impuestos  : [];

  let itemsHTML = productos.map((p, i) => {
    const rubroOpts = RUBROS_GASTO.map(r =>
      `<option value="${escHtml(r)}" ${normalizarRubro(p.rubro) === normalizarRubro(r) ? "selected" : ""}>${r || "— rubro —"}</option>`
    ).join("");
    return `
    <div class="gasto-item-row" style="flex-wrap:wrap;gap:4px 8px;">
      <span class="gasto-item-desc" style="flex:1;min-width:0;">
        ${escHtml(p.descripcion || "—")}
      </span>
      <span class="gasto-item-qty">${p.cantidad} ${p.unidad || ""}</span>
      <span class="gasto-item-price">${fmtUYU(p.subtotal ?? p.precio_unitario ?? 0)}</span>
      <div style="width:100%;padding-left:2px;">
        <select class="gasto-rubro-select${p.rubro ? " asignado" : ""}"
                data-idx="${i}"
                >
          ${rubroOpts}
        </select>
      </div>
    </div>`;
  }).join("");

  let pagosHTML = formas.map(f => `
    <div class="gasto-pago-row">
      <span>${escHtml(f.medio || "—")}</span>
      <span>${fmtUYU(f.monto ?? 0)}</span>
    </div>`).join("");

  let descHTML = descuentos.map(d2 => `
    <div class="gasto-pago-row" style="color:#dc2626;">
      <span>Desc: ${escHtml(d2.descripcion || "—")}</span>
      <span>-${fmtUYU(d2.monto ?? 0)}</span>
    </div>`).join("");

  let ivaHTML = impuestos.map(im => `
    <div class="gasto-pago-row">
      <span>${escHtml(im.tipo || "IVA")}</span>
      <span>${fmtUYU(im.monto ?? 0)}</span>
    </div>`).join("");

  document.getElementById("gastosPreviewCard").innerHTML = `
    <div class="gasto-preview-head">
      ${d.empresa
        ? `<div class="gasto-preview-empresa">${escHtml(d.empresa)}</div>`
        : `<div class="gasto-empresa-selector-wrap">
             <label class="gasto-empresa-label">Empresa <span style="color:#dc2626">*</span></label>
             <select id="gastosEmpresaSelect" class="gasto-empresa-select">
               <option value="">— seleccioná la empresa —</option>
               ${EMPRESAS_GASTO.map(e => `<option value="${escHtml(e)}">${escHtml(e)}</option>`).join("")}
             </select>
           </div>`
      }
      <div class="gasto-preview-meta">
        ${d.sucursal ? escHtml(d.sucursal) + " · " : ""}
        ${d.tipo_documento || ""} ${d.numero_factura ? "#" + d.numero_factura : ""} · 
        ${d.fecha || ""} ${d.hora ? d.hora.slice(0,5) : ""}
      </div>
      ${d.rut ? `<div class="gasto-preview-meta">RUT: ${escHtml(d.rut)}</div>` : ""}
    </div>

    ${productos.length ? `
    <div class="gasto-preview-section">
      <div class="gasto-preview-section-title">
        Productos (${productos.length})
        <span style="font-size:10px;font-weight:500;color:#94a3b8;margin-left:6px;text-transform:none;letter-spacing:0;">
          · asigná el rubro a cada ítem
        </span>
      </div>
      ${itemsHTML}
    </div>` : ""}

    ${formas.length || descuentos.length || ivaHTML ? `
    <div class="gasto-preview-section">
      <div class="gasto-preview-section-title">Pago e impuestos</div>
      ${ivaHTML}
      ${descHTML}
      ${pagosHTML}
    </div>` : ""}

    <div class="gasto-preview-section">
      <div class="gasto-total-row">
        <span>Total factura</span>
        <span>${fmtUYU(d.total ?? 0)}</span>
      </div>
    </div>
  `;
  // Normalizar rubros del gastoParseado contra el array al renderizar
  if (gastoParseado && Array.isArray(gastoParseado.productos)) {
    gastoParseado.productos.forEach((p, i) => {
      const match = RUBROS_GASTO.find(r => r && normalizarRubro(r) === normalizarRubro(p.rubro));
      if (match) gastoParseado.productos[i].rubro = match;
    });
  }
}

function onRubroChange(select) {
  const idx = parseInt(select.dataset.idx, 10);
  if (!gastoParseado || !Array.isArray(gastoParseado.productos)) return;
  gastoParseado.productos[idx].rubro = select.value || null;
  select.classList.toggle("asignado", !!select.value);
  select.classList.toggle("sin-rubro", !select.value);
  // Limpiar error global si ya no quedan rubros pendientes
  if (select.value && !document.querySelector(".gasto-rubro-select.sin-rubro")) {
    document.getElementById("gastosJsonError").classList.remove("visible");
  }
}
function escHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

async function confirmarGasto() {
  if (!gastoParseado) return;

  // Validar empresa si vino null en el JSON (se selecciona en el preview)
  if (!gastoParseado.empresa) {
    const sel = document.getElementById("gastosEmpresaSelect");
    if (!sel || !sel.value) {
      if (sel) {
        sel.classList.add("sin-rubro"); // reutiliza el estilo de error rojo
        void sel.offsetWidth;
      }
      mostrarErrorGasto("Seleccioná la empresa antes de guardar.");
      if (sel) sel.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    gastoParseado.empresa = sel.value;
  }

  // Validar que todos los productos tengan rubro seleccionado
  const productos = Array.isArray(gastoParseado.productos) ? gastoParseado.productos : [];
  if (productos.length > 0) {
    const selectsSinRubro = document.querySelectorAll(".gasto-rubro-select");
    let hayPendientes = false;
    selectsSinRubro.forEach(sel => {
      sel.classList.remove("sin-rubro");
      if (!sel.value) {
        sel.classList.add("sin-rubro");
        hayPendientes = true;
        // Re-trigger animation on repeated attempt
        void sel.offsetWidth;
      }
    });
    if (hayPendientes) {
      mostrarErrorGasto("Asigná el rubro a todos los productos antes de guardar.");
      // Scroll hasta el primer select sin rubro
      const primero = document.querySelector(".gasto-rubro-select.sin-rubro");
      if (primero) primero.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }

  const btn = document.getElementById("gastosConfirmBtn");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2.5px;border-color:rgba(255,255,255,.3);border-top-color:#fff;"></div> Guardando...`;

  try {
    const d = gastoParseado;

    // 1. Insertar cabecera en tabla gastos
    const { data: gastoRow, error: errGasto } = await window.supabase_res
      .from("gastos")
      .insert({
        empresa:          d.empresa        || null,
        sucursal:         d.sucursal       || null,
        direccion:        d.direccion      || null,
        rut:              d.rut            || null,
        tipo_documento:   d.tipo_documento || null,
        numero_factura:   d.numero_factura || null,
        fecha:            d.fecha          || null,
        hora:             d.hora           || null,
        moneda:           "UYU",
        forma_pago:       Array.isArray(d.forma_pago)  ? d.forma_pago  : [],
        impuestos:        Array.isArray(d.impuestos)   ? d.impuestos   : [],
        descuentos:       Array.isArray(d.descuentos)  ? d.descuentos  : [],
        subtotal:         d.subtotal       ?? null,
        total:            d.total          ?? 0,
        observaciones:    Array.isArray(d.observaciones) ? d.observaciones.join(" ") : (d.observaciones || null),
        usuario_username: usuarioActual?.username || null,
        json_original:    d
      })
      .select("id")
      .single();

    if (errGasto) throw errGasto;

    // 2. Insertar items si hay productos
    const productos = Array.isArray(d.productos) ? d.productos : [];
    if (productos.length > 0) {
      const items = productos.map(p => ({
        gasto_id:        gastoRow.id,
        descripcion:     p.descripcion     || null,
        cantidad:        p.cantidad        ?? 1,
        unidad:          p.unidad          || null,
        precio_unitario: p.precio_unitario ?? 0,
        subtotal:        p.subtotal        ?? 0,
        rubro:           p.rubro           || null
      }));

      const { error: errItems } = await window.supabase_res
        .from("gastos_items")
        .insert(items);

      if (errItems) throw errItems;
    }

    showToast("Gasto guardado correctamente.", "success");
    closeGastos();

  } catch(err) {
    console.error("Error guardando gasto:", err);
    mostrarErrorGasto("No se pudo guardar el gasto: " + (err.message || "error desconocido"));
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Confirmar y guardar`;
  }
}

/* ═══════════════════════════════════════
   RESPALDO
═══════════════════════════════════════ */
async function generarRespaldo() {
  const btn = document.getElementById("backupBtn");
  btn.disabled = true;
  btn.classList.add("loading");

  try {
    const { data, error } = await window.supabase_res
      .from("ventas")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const blob  = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement("a");
    a.href      = url;
    a.download  = `respaldo_ventas_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showToast("Respaldo descargado correctamente.", "success");
  } catch (err) {
    console.error("Error en respaldo:", err);
    showToast("Error al generar el respaldo.", "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function fmt(n) {
  return "$" + Math.round(n).toLocaleString("es-UY");
}

function showToast(msg, type = "success") {
  const wrap = document.getElementById("toastWrap");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function normalizarTexto(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function capitalizarTexto(str) {
  return str.toLowerCase().trim().split(/\s+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function playSuccessSound() {
  navigator.vibrate?.(200);
  const audio = document.getElementById("successSound");
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function actualizarTextoToggle(checked) {
  const onText  = document.getElementById("toggleCartaOn");
  const offText = document.getElementById("toggleCartaOff");
  if (!onText || !offText) return;
  onText.style.display  = checked ? "inline" : "none";
  offText.style.display = checked ? "none"   : "inline";

  const rowPrecio  = document.getElementById("rowMostrarPrecio");
  const hintPrecio = document.getElementById("hintMostrarPrecio");
  if (rowPrecio)  { rowPrecio.style.opacity = checked ? "1" : "0.4"; rowPrecio.style.pointerEvents = checked ? "auto" : "none"; }
  if (hintPrecio)   hintPrecio.style.opacity = checked ? "1" : "0.4";
}

function actualizarTextoTogglePrecio(checked) {
  const onText  = document.getElementById("togglePrecioOn");
  const offText = document.getElementById("togglePrecioOff");
  if (!onText || !offText) return;
  onText.style.display  = checked ? "inline" : "none";
  offText.style.display = checked ? "none"   : "inline";
}

/* ═══════════════════════════════════════
   INIT
═══════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("loginUser").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("loginPass").focus();
  });
  document.getElementById("loginPass").addEventListener("keydown", e => {
    if (e.key === "Enter") doLogin();
  });
  document.getElementById("darkModeToggle")?.addEventListener("change", function() {
    toggleDarkMode(this.checked);
  });
  document.getElementById("nombreModalInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter")  guardarNombreMesa();
    if (e.key === "Escape") cerrarNombreModal();
  });
  document.getElementById("prodMostrarCarta")?.addEventListener("change", function() {
    actualizarTextoToggle(this.checked);
  });
  document.getElementById("prodMostrarPrecioCarta")?.addEventListener("change", function() {
    actualizarTextoTogglePrecio(this.checked);
  });

  const logged = await checkSession();
  if (logged) {
    await initMesas();
    iniciarRealtimeMesas();
    await loadUserPreferences();
    await cargarCategorias();
    showMesasScreen();
    cargarProductosSupabase();
  } else {
    showLogin();
  }
});

/* ═══════════════════════════════════════
   REPORTE DE GASTOS
═══════════════════════════════════════ */
let gastosCache      = [];      // array de gastos con sus items embebidos
let gastosRubroFiltro = "todos"; // rubro activo en el chip filter

async function openGastosReport() {
  document.getElementById("gastosReportPanel").classList.add("open");
  await cargarGastos();
  if (typeof pushNavState === "function") pushNavState();
}

function closeGastosReport() {
  document.getElementById("gastosReportPanel").classList.remove("open");
}

/* ═══════════════════════════════════════
   ADMINISTRACIÓN DE PRODUCTOS
═══════════════════════════════════════ */
function openAdminProd() {
  // Resetear filtros al abrir
  adminCatFilter = "todos";
  document.querySelectorAll("#adminCatFilterBar .cat-chip").forEach(c => c.classList.remove("active"));
  const todosBtn = document.querySelector("#adminCatFilterBar .cat-chip[data-admin-cat='todos']");
  if (todosBtn) todosBtn.classList.add("active");
  const searchInput = document.getElementById("adminSearch");
  if (searchInput) { searchInput.value = ""; }
  const clearBtn = document.getElementById("adminSearchClear");
  if (clearBtn) clearBtn.style.display = "none";

  renderAdminProdGrid();
  document.getElementById("adminProdPanel").classList.add("open");
  if (typeof pushNavState === "function") pushNavState();
}

function setAdminCatFilter(cat, btn) {
  adminCatFilter = cat;
  document.querySelectorAll("#adminCatFilterBar .cat-chip").forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  renderAdminProdGrid();
}

function handleAdminSearch() {
  const input = document.getElementById("adminSearch").value;
  document.getElementById("adminSearchClear").style.display = input ? "block" : "none";
  renderAdminProdGrid();
}

function clearAdminSearch() {
  document.getElementById("adminSearch").value = "";
  document.getElementById("adminSearchClear").style.display = "none";
  renderAdminProdGrid();
}


function closeAdminProd() {
  document.getElementById("adminProdPanel").classList.remove("open");
}

function renderAdminProdGrid() {
  const grid = document.getElementById("adminProdGrid");
  grid.innerHTML = "";

  if (!productos || productos.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:40px 0;font-size:14px;">No hay productos cargados</div>`;
    return;
  }

  // Aplicar filtros
  const searchTxt = normalizarTexto((document.getElementById("adminSearch")?.value) || "");
  let lista = productos;
  if (adminCatFilter !== "todos") lista = lista.filter(p => p.categoria === adminCatFilter);
  if (searchTxt) lista = lista.filter(p => normalizarTexto(p.nombre).includes(searchTxt));

  if (lista.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:40px 0;font-size:14px;">
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 10px;display:block;opacity:.4"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      Sin resultados</div>`;
    return;
  }

  lista.forEach(p => {
    const emoji = getCategoryEmoji(p.categoria);
    const card = document.createElement("div");
    card.className = "admin-prod-card";
    card.innerHTML = `
      ${emoji ? `<div class="admin-prod-emoji">${emoji}</div>` : ""}
      <div class="admin-prod-edit-hint">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </div>
      <div class="admin-prod-name">${capitalizarTexto(p.nombre)}</div>
      <div class="admin-prod-bottom">
        <span class="admin-prod-price">${fmt(p.precio)}</span>
        ${p.mostrar_carta === false ? `<span class="admin-prod-badge">Oculto</span>` : ""}
      </div>
    `;

    // Click directo abre el modal de edición
    card.addEventListener("click", () => {
      openProductModal(p);
    });

    // Long press también lo abre (consistencia con el POS)
    let lpTimer = null;
    let didLP = false;
    const startLP = () => { didLP = false; lpTimer = setTimeout(() => { didLP = true; navigator.vibrate?.(50); openProductModal(p); }, 580); };
    const cancelLP = () => { clearTimeout(lpTimer); };
    card.addEventListener("touchstart",  startLP, { passive: true });
    card.addEventListener("touchend",    cancelLP);
    card.addEventListener("touchmove",   cancelLP);
    card.addEventListener("touchcancel", cancelLP);
    card.addEventListener("mousedown",   e => { if (e.button === 0) startLP(); });
    card.addEventListener("mouseup",     cancelLP);
    card.addEventListener("mouseleave",  cancelLP);

    grid.appendChild(card);
  });
}

async function cargarGastos() {
  const content = document.getElementById("gastosReportContent");
  content.innerHTML = `<div class="report-loading"><div class="spinner"></div><span>Cargando gastos...</span></div>`;

  try {
    const { data: gastos, error: errGastos } = await window.supabase_res
      .from("gastos")
      .select("*, gastos_items(*)")
      .order("fecha", { ascending: false })
      .order("created_at", { ascending: false });

    if (errGastos) throw errGastos;

    gastosCache = gastos || [];
    renderRubroChips();
    renderGastosReport();
  } catch(e) {
    console.error("Error cargando gastos:", e);
    content.innerHTML = `
      <div class="report-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
        <p>No se pudo cargar el reporte.<br>Verificá tu conexión e intentá nuevamente.</p>
      </div>`;
  }
}

function renderRubroChips() {
  // Recolectar rubros únicos de todos los items
  const rubrosSet = new Set(["todos"]);
  gastosCache.forEach(g => {
    (g.gastos_items || []).forEach(item => {
      if (item.rubro) rubrosSet.add(item.rubro);
    });
  });

  const chips = document.getElementById("grRubroChips");
  chips.innerHTML = [...rubrosSet].map(r => `
    <button class="gr-rubro-chip${r === gastosRubroFiltro ? " active" : ""}"
            data-rubro="${escHtml(r)}">
      ${r === "todos" ? "Todos los rubros" : escHtml(r)}
    </button>`).join("");
}

function setRubroFiltroGastos(rubro, btn) {
  gastosRubroFiltro = rubro;
  document.querySelectorAll(".gr-rubro-chip").forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  renderGastosReport();
}

function setQuickFilterGastos(tipo, btn) {
  document.querySelectorAll("#gastosReportPanel .qf-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  const hoy = new Date();
  let desde = "", hasta = "";

  if (tipo === "hoy") {
    desde = hasta = toDateStr(hoy);
  } else if (tipo === "semana") {
    const lunes = new Date(hoy);
    lunes.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
    desde = toDateStr(lunes);
    hasta = toDateStr(hoy);
  } else if (tipo === "mes") {
    desde = toDateStr(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    hasta = toDateStr(hoy);
  }

  document.getElementById("grFechaDesde").value = desde;
  document.getElementById("grFechaHasta").value = hasta;
  renderGastosReport();
}

function aplicarFiltroGastos() {
  document.querySelectorAll("#gastosReportPanel .qf-btn").forEach(b => b.classList.remove("active"));
  renderGastosReport();
}

function renderGastosReport() {
  const desde = document.getElementById("grFechaDesde").value;
  const hasta  = document.getElementById("grFechaHasta").value;
  const content = document.getElementById("gastosReportContent");

  // Filtrar por fecha (campo `fecha` es tipo date: "YYYY-MM-DD")
  let gastos = gastosCache.filter(g => {
    if (!g.fecha) return true;
    if (desde && g.fecha < desde) return false;
    if (hasta  && g.fecha > hasta)  return false;
    return true;
  });

  // Filtrar por rubro: si el filtro no es "todos", solo incluir gastos
  // que tengan al menos un item con ese rubro
  if (gastosRubroFiltro !== "todos") {
    gastos = gastos.filter(g =>
      (g.gastos_items || []).some(i =>
        normalizarRubro(i.rubro) === normalizarRubro(gastosRubroFiltro)
      )
    );
  }

  if (gastos.length === 0) {
    content.innerHTML = `
      <div class="report-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <p>No hay gastos en el período seleccionado.</p>
      </div>`;
    return;
  }

  // ── Totales generales ──
  const totalGastos   = gastos.reduce((s, g) => s + (parseFloat(g.total) || 0), 0);
  const totalFacturas = gastos.length;

  // Total de items (considerando filtro de rubro)
  const itemsFiltrados = gastos.flatMap(g => {
    const items = g.gastos_items || [];
    return gastosRubroFiltro === "todos"
      ? items
      : items.filter(i => normalizarRubro(i.rubro) === normalizarRubro(gastosRubroFiltro));
  });
  const totalItems = itemsFiltrados.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);

  // ── Totales por rubro ──
  const rubroMap = {};
  gastosCache
    .filter(g => {
      if (!g.fecha) return true;
      if (desde && g.fecha < desde) return false;
      if (hasta  && g.fecha > hasta)  return false;
      return true;
    })
    .forEach(g => {
      (g.gastos_items || []).forEach(i => {
        const r = i.rubro || "Sin rubro";
        if (!rubroMap[r]) rubroMap[r] = 0;
        rubroMap[r] += parseFloat(i.subtotal) || 0;
      });
    });

  const rubrosOrdenados = Object.entries(rubroMap).sort((a, b) => b[1] - a[1]);

  content.innerHTML = `
    <div class="gr-summary-grid">
      <div class="gr-summary-card red">
        <div class="gr-summary-label">Total gastado</div>
        <div class="gr-summary-value">${fmtUYU(totalGastos)}</div>
      </div>
      <div class="gr-summary-card blue">
        <div class="gr-summary-label">Facturas</div>
        <div class="gr-summary-value">${totalFacturas}</div>
      </div>
    </div>

    <div class="gr-por-rubro-card">
      <h3>Gasto por rubro</h3>
      ${rubrosOrdenados.map(([r, t]) => `
        <div class="gr-rubro-row">
          <span class="gr-rubro-name">${escHtml(r)}</span>
          <span class="gr-rubro-total">${fmtUYU(t)}</span>
        </div>`).join("") || `<div style="padding:16px;font-size:13px;color:#94a3b8;">Sin datos de rubros.</div>`}
    </div>

    <div class="gr-table-card">
      <h3>Facturas (${totalFacturas})</h3>
      ${gastos.map((g, idx) => {
        const items = gastosRubroFiltro === "todos"
          ? (g.gastos_items || [])
          : (g.gastos_items || []).filter(i => normalizarRubro(i.rubro) === normalizarRubro(gastosRubroFiltro));
        const itemsHtml = items.map(i => `
          <div class="gr-item-row">
            <span class="gr-item-desc">${escHtml(i.descripcion || "—")} <span style="color:#94a3b8">x${i.cantidad || 1}</span></span>
            ${i.rubro ? `<span class="gr-item-rubro">${escHtml(i.rubro)}</span>` : ""}
            <span class="gr-item-subtotal">${fmtUYU(i.subtotal ?? 0)}</span>
          </div>`).join("");
        return `
        <div class="gr-gasto-row" id="grg_${idx}">
          <div class="gr-gasto-header" data-gasto-idx="${idx}">
            <div>
              <div class="gr-gasto-empresa">${escHtml(g.empresa || "Sin nombre")}</div>
              <div class="gr-gasto-meta">
                ${g.fecha || ""}${g.sucursal ? " · " + escHtml(g.sucursal) : ""}
                ${g.tipo_documento ? " · " + escHtml(g.tipo_documento) : ""}
                ${g.numero_factura ? " #" + escHtml(g.numero_factura) : ""}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="gr-gasto-total">${fmtUYU(g.total ?? 0)}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </div>
          </div>
          <div class="gr-gasto-items">${itemsHtml || `<span style="font-size:12px;color:#94a3b8;">Sin ítems registrados.</span>`}</div>
        </div>`;
      }).join("")}
    </div>
  `;
}

function toggleGastoRow(idx) {
  document.getElementById("grg_" + idx)?.classList.toggle("open");
}


/* ═══════════════════════════════════════════════════════════════
   EVENT WIRING
   Reemplaza todos los onclick/oninput/onchange inline del HTML.
   Se ejecuta después de que el DOM esté listo.
═══════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {

  // ── Delegación global para data-action (clicks) ──────────────
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;

    const action = el.dataset.action;
    const arg    = el.dataset.arg;
    const cat    = el.dataset.cat;
    const qf     = el.dataset.qf;

    switch (action) {
      // Auth
      case "doLogin":                doLogin();                     break;
      case "doLogout":               doLogout();                    break;

      // Admin menu
      case "toggleAdminMenu":        toggleAdminMenu();             break;
      case "adminMenuAction":        adminMenuAction(arg);          break;

      // Navegación
      case "volverAMesas":           volverAMesas();                break;
      case "recargarProductos":      recargarProductos(arg === "true"); break;

      // Búsqueda
      case "clearSearch":            clearSearch();                 break;

      // Filtro categorías (el botón tiene data-cat)
      case "setCatFilter":           setCatFilter(cat, el);         break;

      // Drawer / carrito
      case "openDrawer":             openDrawer();                  break;
      case "closeDrawer":            closeDrawer();                 break;
      case "abrirCambio":            abrirCambio(arg);              break;
      case "pagar":                  pagar(arg);                    break;
      case "cobrarVenta":            cobrarVenta();                 break;
      case "clearCart":              clearCart();                   break;
      case "limpiarPagosPorMonto":   limpiarPagosPorMonto();        break;

      // Modal cambio efectivo
      case "handleCambioOverlayClick": handleCambioOverlayClick(e); break;
      case "cerrarCambio":           cerrarCambio();                break;
      case "confirmarPagoEfectivo":  confirmarPagoEfectivo();       break;

      // Reporte ventas
      case "closeReport":            closeReport();                 break;
      case "generarRespaldo":        generarRespaldo();             break;
      case "cargarVentas":           cargarVentas(arg === "true");  break;
      case "aplicarFiltro":          aplicarFiltro();               break;
      case "setQuickFilter":         setQuickFilter(qf, el);        break;

      // Gastos (ingreso)
      case "closeGastos":            closeGastos();                 break;
      case "switchGastosTab":        switchGastosTab(arg);          break;
      case "parsearGastoJson":       parsearGastoJson();            break;
      case "confirmarGasto":         confirmarGasto();              break;

      // Modal producto
      case "handleModalOverlayClick": handleModalOverlayClick(e);   break;
      case "closeProductModal":      closeProductModal();           break;
      case "eliminarProducto":       eliminarProducto();            break;
      case "guardarProducto":        guardarProducto();             break;

      // Modal nombre mesa
      case "handleNombreOverlayClick": handleNombreOverlayClick(e); break;
      case "cerrarNombreModal":      cerrarNombreModal();           break;
      case "guardarNombreMesa":      guardarNombreMesa();           break;

      // Formulario manual de gastos
      case "gmAgregarLinea":         gmAgregarLinea();             break;
      case "guardarGastoManual":     guardarGastoManual();         break;

      // Reporte gastos
      case "closeGastosReport":      closeGastosReport();          break;
      // Cruce ingresos vs gastos
      case "closeCruce":             closeCruce();                  break;
      case "recargarCruce":          cargarCruce();                 break;
      case "aplicarFiltroCruce":     aplicarFiltroCruce();          break;
      case "setQuickFilterCruce":    setQuickFilterCruce(qf, el);   break;
      case "closeAdminProd":         closeAdminProd();             break;
      case "openAddProductoAdmin":   openProductModal(null);       break;
      case "setAdminCatFilter":      setAdminCatFilter(el.dataset.adminCat, el); break;
      case "clearAdminSearch":       clearAdminSearch();           break;
      case "cargarGastos":           cargarGastos();               break;
      case "aplicarFiltroGastos":    aplicarFiltroGastos();        break;
      case "setQuickFilterGastos":   setQuickFilterGastos(qf, el); break;
      // Configuración
      case "closeConfig":            closeConfig();                break;
      case "toggleCatActivo": {
        const id     = el.dataset.id;
        const activo = el.dataset.activo === "true";
        toggleCategoriaActivo(id, !activo);
        break;
      }
      case "crearCategoria":         crearCategoria();             break;
      case "toggleCatActivo": {
        const id     = el.dataset.id;
        const activo = el.dataset.activo === "true";
        toggleCategoriaActivo(id, !activo);
        break;
      }
      case "crearCategoria":         crearCategoria();             break;
    }
  });

  // ── Delegación global para data-oninput ──────────────────────
  document.addEventListener("input", (e) => {
    const pagoMonto = e.target.closest("[data-pago-monto]");
    if (pagoMonto) {
      const metodo = pagoMonto.dataset.pagoMonto;
      pagosPorMonto[metodo] = pagoMonto.value;
      actualizarEstadoPagosMonto(calcularTotalActual());
      return;
    }

    const el = e.target.closest("[data-oninput]");
    if (!el) return;

    switch (el.dataset.oninput) {
      case "handleSearch":       handleSearch();       break;
      case "handleAdminSearch":  handleAdminSearch();  break;
      case "updateDrawerTotal":  updateDrawerTotal();  break;
      case "calcularCambio":     calcularCambio();     break;
      case "onGastosJsonInput":  onGastosJsonInput();  break;
    }
  });

  // ── Delegación para eventos dinámicos (generados en innerHTML) ─
  // changeQty, removeFromCart → botones con data-qty-id / data-remove-id
  // Se usan data-* en las funciones que generan el HTML dinámico (ver abajo).
  document.addEventListener("click", (e) => {

    // Modo de cobro: Por producto / Por monto
    const modoCobroBtn = e.target.closest("[data-modo-cobro]");
    if (modoCobroBtn) {
      setModoCobro(modoCobroBtn.dataset.modoCobro);
      return;
    }

    // cambiarMetodoPago: chips de método generados con data-mp-key y data-mp-metodo
    const mpChip = e.target.closest("[data-mp-key]");
    if (mpChip) {
      cambiarMetodoPago(mpChip.dataset.mpKey, mpChip.dataset.mpMetodo);
      return;
    }

    // changeQty: botones generados con data-qty-id y data-qty-delta
    const qtyBtn = e.target.closest("[data-qty-id]");
    if (qtyBtn) {
      changeQty(qtyBtn.dataset.qtyId, Number(qtyBtn.dataset.qtyDelta));
      return;
    }

    // removeFromCart: botones generados con data-remove-id
    const removeBtn = e.target.closest("[data-remove-id]");
    if (removeBtn) {
      removeFromCart(removeBtn.dataset.removeId);
      return;
    }

    // setMontoRapido: botones generados con data-monto
    const montoBtn = e.target.closest("[data-monto]");
    if (montoBtn) {
      setMontoRapido(Number(montoBtn.dataset.monto));
      return;
    }

    // toggleGrupo: divs generados con data-grupo-idx
    const grupoHeader = e.target.closest("[data-grupo-idx]");
    if (grupoHeader) {
      toggleGrupo(Number(grupoHeader.dataset.grupoIdx));
      return;
    }

    // setRubroFiltroGastos: botones generados con data-rubro
    const rubroChip = e.target.closest("[data-rubro]");
    if (rubroChip) {
      setRubroFiltroGastos(rubroChip.dataset.rubro, rubroChip);
      return;
    }

    // toggleGastoRow: divs generados con data-gasto-idx
    const gastoHeader = e.target.closest("[data-gasto-idx]");
    if (gastoHeader) {
      toggleGastoRow(Number(gastoHeader.dataset.gastoIdx));
      return;
    }
  });

  // ── onchange dinámico: select de rubro en gastos ─────────────
  document.addEventListener("change", (e) => {
    if (e.target.matches(".gasto-rubro-select")) {
      onRubroChange(e.target);
    }
    // Select de empresa cuando viene null en el JSON
    if (e.target.matches("#gastosEmpresaSelect")) {
      const sel = e.target;
      sel.classList.remove("sin-rubro");
      if (sel.value) {
        gastoParseado && (gastoParseado.empresa = sel.value);
        document.getElementById("gastosJsonError").classList.remove("visible");
      }
    }
    // Select de rubro en formulario manual
    if (e.target.matches("[data-gm-field='rubro']")) {
      const id = Number(e.target.dataset.gmId);
      gmActualizarCampo(id, "rubro", e.target.value);
    }
  });

  // ── Chips de modo de pago (formulario manual) ─────────────────
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".gm-pago-chip");
    if (chip) {
      document.querySelectorAll(".gm-pago-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      gmPagoSeleccionado = chip.dataset.pago;
    }

    // Eliminar línea de producto
    const removeBtn = e.target.closest("[data-gm-remove]");
    if (removeBtn) {
      const id = Number(removeBtn.dataset.gmRemove);
      // No eliminar si es la única línea
      const rows = document.querySelectorAll("#gmProductosContainer .gm-producto-row");
      if (rows.length > 1) {
        gmEliminarLinea(id);
      }
    }
  });

  // ── Inputs de líneas de producto (formulario manual) ──────────
  document.addEventListener("input", (e) => {
    const field = e.target.dataset.gmField;
    const id    = Number(e.target.dataset.gmId);
    if (field && id && field !== "rubro") {
      gmActualizarCampo(id, field, e.target.value);
    }
  });

});


/* ═══════════════════════════════════════════════════════════════
   CARGA MANUAL DE GASTOS
═══════════════════════════════════════════════════════════════ */

let gmPagoSeleccionado = null;
let gmLineas = [];      // [{ id, descripcion, rubro, cantidad, costo }]
let gmLineasCounter = 0;

function gmFechaHoy() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function gmInicializar() {
  document.getElementById("gmEmpresa").value     = "";
  document.getElementById("gmFecha").value       = gmFechaHoy();
  document.getElementById("gmNroFactura").value  = "";
  document.getElementById("gmProductosContainer").innerHTML = "";
  document.getElementById("gmTotalDisplay").textContent = fmtUYU(0);
  document.querySelectorAll(".gm-pago-chip").forEach(c => c.classList.remove("active"));
  document.querySelectorAll(".gm-input").forEach(i => i.classList.remove("error"));
  document.getElementById("gastosManualError").textContent = "";
  document.getElementById("gastosManualError").classList.remove("visible");
  gmPagoSeleccionado = null;
  gmLineas = [];
  gmLineasCounter = 0;
  // Empezar con una línea vacía
  gmAgregarLinea();
}

function gmAgregarLinea() {
  const id = ++gmLineasCounter;
  gmLineas.push({ id, descripcion: "", rubro: "", cantidad: 1, costo: 0 });

  const rubroOpts = RUBROS_GASTO.map(r =>
    `<option value="${escHtml(r)}">${r || "— rubro —"}</option>`
  ).join("");

  const row = document.createElement("div");
  row.className = "gm-producto-row";
  row.dataset.lineaId = id;
  row.innerHTML = `
    <div class="gm-producto-row-top">
      <input class="gm-input" type="text" placeholder="Descripción del producto" data-gm-field="descripcion" data-gm-id="${id}" autocomplete="off">
      <button class="gm-remove-btn" data-gm-remove="${id}" title="Eliminar línea">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="gm-producto-row-bottom">
      <select class="gm-input gasto-rubro-select" data-gm-field="rubro" data-gm-id="${id}">${rubroOpts}</select>
      <input class="gm-input" type="number" placeholder="Cant." min="0.01" step="any" value="1" data-gm-field="cantidad" data-gm-id="${id}">
      <div class="gm-costo-wrap">
        <span class="gm-costo-prefix">$</span>
        <input class="gm-input" type="number" placeholder="0" min="0" step="any" value="" data-gm-field="costo" data-gm-id="${id}">
      </div>
    </div>
  `;
  document.getElementById("gmProductosContainer").appendChild(row);
}

function gmEliminarLinea(id) {
  gmLineas = gmLineas.filter(l => l.id !== id);
  const row = document.querySelector(`[data-linea-id="${id}"]`);
  if (row) row.remove();
  gmRecalcularTotal();
}

function gmActualizarCampo(id, field, value) {
  const linea = gmLineas.find(l => l.id === id);
  if (!linea) return;
  if (field === "cantidad" || field === "costo") {
    linea[field] = parseFloat(value) || 0;
  } else {
    linea[field] = value;
  }
  gmRecalcularTotal();
}

function gmRecalcularTotal() {
  const total = gmLineas.reduce((acc, l) => acc + (l.cantidad * l.costo), 0);
  document.getElementById("gmTotalDisplay").textContent = fmtUYU(total);
  return total;
}

function mostrarErrorManual(msg) {
  const el = document.getElementById("gastosManualError");
  el.textContent = msg;
  el.classList.add("visible");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function guardarGastoManual() {
  // Limpiar errores previos
  document.getElementById("gastosManualError").classList.remove("visible");
  document.querySelectorAll("#gastosTabManual .gm-input").forEach(i => i.classList.remove("error"));

  // Validar campos obligatorios
  const empresa = document.getElementById("gmEmpresa").value.trim();
  const fecha   = document.getElementById("gmFecha").value.trim();
  const nroFact = document.getElementById("gmNroFactura").value.trim();

  if (!empresa) {
    document.getElementById("gmEmpresa").classList.add("error");
    mostrarErrorManual("El nombre de la empresa es obligatorio.");
    return;
  }
  if (!fecha) {
    document.getElementById("gmFecha").classList.add("error");
    mostrarErrorManual("La fecha es obligatoria.");
    return;
  }
  if (!gmPagoSeleccionado) {
    mostrarErrorManual("Seleccioná un modo de pago.");
    return;
  }

  // Armar productos desde el DOM (fuente de verdad)
  const rows = document.querySelectorAll("#gmProductosContainer .gm-producto-row");
  const productos = [];
  for (const row of rows) {
    const id       = Number(row.dataset.lineaId);
    const desc     = row.querySelector("[data-gm-field='descripcion']").value.trim();
    const rubro    = row.querySelector("[data-gm-field='rubro']").value;
    const cantidad = parseFloat(row.querySelector("[data-gm-field='cantidad']").value) || 0;
    const costo    = parseFloat(row.querySelector("[data-gm-field='costo']").value)    || 0;

    if (!desc && cantidad === 0 && costo === 0) continue; // ignorar filas vacías

    productos.push({
      descripcion:     desc || "Sin descripción",
      rubro:           rubro || null,
      cantidad,
      unidad:          null,
      precio_unitario: costo,
      subtotal:        cantidad * costo,
    });
  }

  const total = productos.reduce((acc, p) => acc + p.subtotal, 0);

  // Construir objeto igual al gastoParseado del flujo JSON
  const d = {
    empresa,
    fecha,
    numero_factura:   nroFact || null,
    sucursal:         null,
    rut:              null,
    tipo_documento:   null,
    hora:             null,
    moneda:           "UYU",
    forma_pago:       [{ medio: gmPagoSeleccionado, monto: total }],
    impuestos:        [],
    descuentos:       [],
    subtotal:         total,
    total,
    observaciones:    null,
    productos,
  };

  const btn = document.getElementById("gmGuardarBtn");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2.5px;border-color:rgba(255,255,255,.3);border-top-color:#fff;"></div> Guardando...`;

  try {
    const { data: gastoRow, error: errGasto } = await window.supabase_res
      .from("gastos")
      .insert({
        empresa:          d.empresa,
        sucursal:         d.sucursal,
        direccion:        null,
        rut:              d.rut,
        tipo_documento:   d.tipo_documento,
        numero_factura:   d.numero_factura,
        fecha:            d.fecha,
        hora:             d.hora,
        moneda:           "UYU",
        forma_pago:       d.forma_pago,
        impuestos:        [],
        descuentos:       [],
        subtotal:         d.subtotal,
        total:            d.total,
        observaciones:    null,
        usuario_username: usuarioActual?.username || null,
        json_original:    d,
      })
      .select("id")
      .single();

    if (errGasto) throw errGasto;

    if (productos.length > 0) {
      const items = productos.map(p => ({
        gasto_id:        gastoRow.id,
        descripcion:     p.descripcion,
        cantidad:        p.cantidad,
        unidad:          p.unidad,
        precio_unitario: p.precio_unitario,
        subtotal:        p.subtotal,
        rubro:           p.rubro,
      }));

      const { error: errItems } = await window.supabase_res
        .from("gastos_items")
        .insert(items);

      if (errItems) throw errItems;
    }

    showToast("Gasto guardado correctamente.", "success");
    closeGastos();

  } catch(err) {
    console.error("Error guardando gasto manual:", err);
    mostrarErrorManual("No se pudo guardar el gasto: " + (err.message || "error desconocido"));
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Guardar gasto`;
  }
}


/* ═══════════════════════════════════════════════════════════════
   NAVEGACIÓN NATIVA - BOTÓN ATRÁS (Android / PWA)
   ─────────────────────────────────────────────────────────────
   Estrategia: history.pushState al abrir cada pantalla/panel.
   El evento "popstate" (botón atrás físico) cierra la capa
   superior. Doble toque en pantalla raíz → cierra la app.

   Jerarquía de capas (más interna → más externa):
     productModal > adminProd > gastosReport > gastos >
     report > drawer > pos > mesas > login
═══════════════════════════════════════════════════════════════ */

// ── Función pública usada por los openers ──────────────────────
function pushNavState() {
  history.pushState({ pwaNav: true }, "");
}

// ── Qué capa está activa ───────────────────────────────────────
function getActiveLayer() {
  if (document.getElementById("productModalOverlay")?.classList.contains("open"))
    return "productModal";
  if (document.getElementById("adminProdPanel")?.classList.contains("open"))
    return "adminProd";
  if (document.getElementById("gastosReportPanel")?.classList.contains("open"))
    return "gastosReport";
  if (document.getElementById("crucePanel")?.classList.contains("open"))
    return "cruce";
  if (document.getElementById("gastosPanel")?.classList.contains("open"))
    return "gastos";
  if (document.getElementById("reportPanel")?.classList.contains("open"))
    return "report";
  if (document.getElementById("configPanel")?.classList.contains("open"))
    return "config";
  if (document.getElementById("drawer")?.classList.contains("open"))
    return "drawer";

  const pos   = document.getElementById("posApp");
  const mesas = document.getElementById("mesasScreen");

  if (pos   && pos.style.display   !== "none" && pos.style.display   !== "")  return "pos";
  if (mesas && mesas.style.display !== "none" && mesas.style.display !== "")  return "mesas";
  return "login";
}

// ── Navegación hacia atrás ─────────────────────────────────────
let _lastBackPress = 0;
const _EXIT_DELAY  = 2000;

function navigateBack() {
  switch (getActiveLayer()) {
    case "productModal":  closeProductModal();  break;
    case "adminProd":     closeAdminProd();     break;
    case "gastosReport":  closeGastosReport();  break;
    case "cruce":         closeCruce();         break;
    case "gastos":        closeGastos();        break;
    case "report":        closeReport();        break;
    case "config":        closeConfig();        break;
    case "drawer":        closeDrawer();        break;
    case "pos":           volverAMesas();       break;
    default:
      // Estamos en mesas o login → doble toque para salir
      if (Date.now() - _lastBackPress < _EXIT_DELAY) {
        try { window.close(); } catch (_) {}
        navigator.app?.exitApp?.();
      } else {
        _lastBackPress = Date.now();
        showToast("Presioná atrás de nuevo para salir", "info");
      }
  }
}

// ── Listener del botón atrás ───────────────────────────────────
window.addEventListener("popstate", () => {
  // Reponemos el centinela ANTES de procesar la navegación.
  // Si lo hacemos después, hay un frame en que el historial queda
  // con longitud 1 (solo la raíz) y Android puede salir de la app
  // antes de que pushNavState() lo remedie.
  // Solo login no necesita centinela: ahí sí queremos que el SO
  // maneje el atrás (salir o volver al launcher).
  const layer = getActiveLayer();
  if (layer !== "login") {
    pushNavState();
  }
  navigateBack();
});

// ── Semilla inicial del history ────────────────────────────────
window.addEventListener("load", () => {
  history.replaceState({ pwaNav: true, root: true }, "");
  pushNavState();
});

/* ── Indicador online / offline ─────────────────────────────── */
function updateOnlineBadge() {
  const online = navigator.onLine;
  ["offlineBadge", "offlineBadgePOS"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = online ? "none" : "";
  });
  if (!online) showToast("Sin conexión — verificá la red", "error");
}
window.addEventListener("online",  updateOnlineBadge);
window.addEventListener("offline", updateOnlineBadge);

/* ═══════════════════════════════════════════════════════════════
   CONFIGURACIÓN
═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════
   GESTIÓN DE CATEGORÍAS
═══════════════════════════════════════ */
async function crearCategoria() {
  const nombre = document.getElementById("newCatNombre")?.value.trim();
  const emoji  = document.getElementById("newCatEmoji")?.value.trim() || "";
  const color  = document.getElementById("newCatColor")?.value || "#94a3b8";
  if (!nombre) { showToast("Ingresá un nombre.", "error"); return; }
  const slug = nombre.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (categorias.find(c => c.slug === slug)) { showToast("Ya existe una categoría con ese nombre.", "error"); return; }
  const orden = categorias.length > 0 ? Math.max(...categorias.map(c => c.orden)) + 1 : 1;
  const btn = document.getElementById("newCatBtn");
  if (btn) btn.classList.add("loading");
  const { data, error } = await window.supabase_res
    .from("categorias").insert({ slug, nombre, emoji, color, orden, activo: true }).select().single();
  if (btn) btn.classList.remove("loading");
  if (error) { console.error(error); showToast("Error al crear la categoría.", "error"); return; }
  categorias.push(data);
  categorias.sort((a, b) => a.orden - b.orden);
  renderCatChips(); renderCatOptions(); renderConfigCategorias();
  document.getElementById("newCatNombre").value = "";
  document.getElementById("newCatEmoji").value  = "";
  document.getElementById("newCatColor").value  = "#94a3b8";
  showToast(`Categoría "${nombre}" creada.`, "success");
}

async function toggleCategoriaActivo(id, activo) {
  const { error } = await window.supabase_res.from("categorias").update({ activo }).eq("id", id);
  if (error) { showToast("Error al actualizar la categoría.", "error"); return; }
  await cargarCategorias();
  renderConfigCategorias();
  showToast(activo ? "Categoría activada." : "Categoría desactivada.", "success");
}

async function renderConfigCategorias() {
  const list = document.getElementById("configCatList");
  if (!list) return;
  const { data: todas } = await window.supabase_res.from("categorias").select("*").order("orden");
  if (!todas || todas.length === 0) {
    list.innerHTML = '<p style="color:var(--muted-fg);font-size:13px;padding:8px 0;">Sin categorías.</p>';
    return;
  }
  list.innerHTML = todas.map(c => `
    <div class="config-cat-item${c.activo ? "" : " config-cat-inactive"}">
      <span class="config-cat-dot" style="background:${c.color}"></span>
      <span class="config-cat-emoji">${c.emoji}</span>
      <span class="config-cat-nombre">${c.nombre}</span>
      <button class="config-cat-toggle" data-action="toggleCatActivo" data-id="${c.id}" data-activo="${c.activo}" title="${c.activo ? "Desactivar" : "Activar"}">
        ${c.activo
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        }
      </button>
    </div>`).join("");
}

// ── Panel Configuración ────────────────────────────────────────
function openConfig() {
  const seccionCat = document.getElementById("configSeccionCategorias");
  if (seccionCat) seccionCat.style.display = usuarioActual?.rol === "administrador" ? "block" : "none";
  const toggle = document.getElementById("darkModeToggle");
  if (toggle) toggle.checked = document.documentElement.getAttribute("data-theme") === "dark";
  // Cargar lista de categorías solo si la sección es visible (admin) y sin bloquear el panel
  if (usuarioActual?.rol === "administrador") {
    renderConfigCategorias().catch(e => console.error("Error cargando categorías en config:", e));
  }
  document.getElementById("configPanel").classList.add("open");
  if (typeof pushNavState === "function") pushNavState();
}

function closeConfig() {
  document.getElementById("configPanel").classList.remove("open");
}

// ── Modo oscuro ────────────────────────────────────────────────
async function toggleDarkMode(enabled) {
  applyTheme(enabled);
  await saveUserPreference("dark_mode", enabled);
}

function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  // Actualizar theme-color del meta para la barra de estado Android
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#1e293b" : "#1d4ed8";
}

async function saveUserPreference(key, value) {
  if (!usuarioActual?.id) return;
  // Optimistic update local
  if (!usuarioActual.preferencias) usuarioActual.preferencias = {};
  usuarioActual.preferencias[key] = value;
  try {
    // Leer las preferencias actuales desde BD, mergear y guardar
    // Esto evita condiciones de carrera: no pisa otras preferencias guardadas en BD
    const { data: fresh, error: fetchError } = await window.supabase_res
      .from("usuarios")
      .select("preferencias")
      .eq("id", usuarioActual.id)
      .single();

    if (fetchError) {
      console.error("Error leyendo preferencias:", fetchError.message);
      return;
    }

    const merged = { ...(fresh?.preferencias ?? {}), [key]: value };
    const { error: updateError } = await window.supabase_res
      .from("usuarios")
      .update({ preferencias: merged })
      .eq("id", usuarioActual.id);

    if (updateError) {
      console.error("Error guardando preferencia:", updateError.message);
    } else {
      // Confirmar estado local con el merge guardado en BD
      usuarioActual.preferencias = merged;
    }
  } catch(e) {
    console.error("Error guardando preferencia:", e);
  }
}

async function loadUserPreferences() {
  // usuarioActual ya viene cargado con preferencias desde checkSession() o doLogin()
  // Si preferencias es null/undefined tratar como objeto vacío
  const prefs = usuarioActual?.preferencias ?? {};
  if (typeof prefs.dark_mode === "boolean") {
    applyTheme(prefs.dark_mode);
    // Sincronizar el toggle por si el panel ya está montado
    const toggle = document.getElementById("darkModeToggle");
    if (toggle) toggle.checked = prefs.dark_mode;
  }
}



/* ═══════════════════════════════════════════════════════════════
   REPORTE CRUCE INGRESOS VS GASTOS
   Los ingresos se calculan con la rebaja IVA de la ley de
   inclusión financiera, igual que en el reporte de ingresos.
═══════════════════════════════════════════════════════════════ */

window._cruceGastos = [];

async function openCruce() {
  document.getElementById("crucePanel").classList.add("open");
  await cargarCruce();
  if (typeof pushNavState === "function") pushNavState();
}

function closeCruce() {
  document.getElementById("crucePanel").classList.remove("open");
}

function setQuickFilterCruce(tipo, btn) {
  document.querySelectorAll("#crucePanel .qf-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const hoy = new Date();
  let desde = "", hasta = "";
  if (tipo === "hoy") {
    desde = hasta = toDateStr(hoy);
  } else if (tipo === "semana") {
    const lunes = new Date(hoy);
    lunes.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
    desde = toDateStr(lunes);
    hasta = toDateStr(hoy);
  } else if (tipo === "mes") {
    desde = toDateStr(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    hasta = toDateStr(hoy);
  }
  document.getElementById("cruceFechaDesde").value = desde;
  document.getElementById("cruceFechaHasta").value = hasta;
  renderCruce();
}

function aplicarFiltroCruce() {
  document.querySelectorAll("#crucePanel .qf-btn").forEach(b => b.classList.remove("active"));
  renderCruce();
}

async function cargarCruce() {
  const content = document.getElementById("cruceContent");
  content.innerHTML = `<div class="report-loading"><div class="spinner"></div><span>Cargando datos...</span></div>`;
  try {
    // Cargar ventas si el caché está vacío
    if (ventasCache.length === 0) {
      await cargarVentas();
    }
    // Cargar gastos (solo id, fecha, total — liviano)
    const { data: gastos, error } = await window.supabase_res
      .from("gastos")
      .select("id, fecha, total")
      .order("fecha", { ascending: true });
    if (error) throw error;
    window._cruceGastos = gastos || [];

    // Setear filtro "este mes" por defecto
    const hoy = new Date();
    document.getElementById("cruceFechaDesde").value =
      toDateStr(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    document.getElementById("cruceFechaHasta").value = toDateStr(hoy);
    document.querySelectorAll("#crucePanel .qf-btn").forEach(b => b.classList.remove("active"));
    const mesBtn = document.querySelector("#crucePanel .qf-btn[data-qf='mes']");
    if (mesBtn) mesBtn.classList.add("active");

    renderCruce();
  } catch (e) {
    console.error("Error cruce:", e);
    content.innerHTML = `
      <div class="report-empty">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
        <p>No se pudo cargar el reporte.<br>Verificá tu conexión e intentá nuevamente.</p>
      </div>`;
  }
}

function renderCruce() {
  const desde = document.getElementById("cruceFechaDesde").value;
  const hasta  = document.getElementById("cruceFechaHasta").value;
  const content = document.getElementById("cruceContent");

  // ── Ventas únicas filtradas por fecha ──
  const ventasUnicas = new Map();
  ventasCache.forEach(v => {
    if (!ventasUnicas.has(v.ventaId)) ventasUnicas.set(v.ventaId, v);
  });
  const ventasFiltradas = [...ventasUnicas.values()].filter(v => {
    const f = v.fecha ? toDateStr(new Date(v.fecha)) : "";
    if (desde && f < desde) return false;
    if (hasta  && f > hasta)  return false;
    return true;
  });

  // ── Gastos filtrados por fecha ──
  const gastos = (window._cruceGastos || []).filter(g => {
    if (!g.fecha) return true;
    if (desde && g.fecha < desde) return false;
    if (hasta  && g.fecha > hasta)  return false;
    return true;
  });

  // ── Desglose ingresos por método de pago (igual que renderReporte) ──
  let efectivo = 0, debito = 0, credito = 0;
  ventasFiltradas.forEach(v => {
    if (v.pagos && typeof v.pagos === "object") {
      efectivo += Math.max(parseFloat(v.pagos.efectivo) || 0, 0);
      debito   += Math.max(parseFloat(v.pagos.debito)   || 0, 0);
      credito  += Math.max(parseFloat(v.pagos.credito)  || 0, 0);
    } else {
      const monto = Math.max(parseFloat(v.ventaTotal) || 0, 0);
      const m = String(v.metodo || "").toLowerCase();
      if (m === "efectivo")     efectivo += monto;
      else if (m === "debito")  debito   += monto;
      else if (m === "credito") credito  += monto;
      else                      efectivo += monto;
    }
  });

  // ── Rebaja IVA Ley Inclusión Financiera (idéntico a renderReporte) ──
  const divisorIVA       = 100 + IVA_TASA;
  const debitoDescuento  = debito  * IVA_REBAJA_DEBITO  / divisorIVA;
  const creditoDescuento = credito * IVA_REBAJA_CREDITO / divisorIVA;
  const debitoNeto       = debito  - debitoDescuento;
  const creditoNeto      = credito - creditoDescuento;
  const totalDescuentoIVA = debitoDescuento + creditoDescuento;

  // ── KPIs finales ──
  const totalIngresos = efectivo + debitoNeto + creditoNeto;  // ingresos reales netos de IVA rebajado
  const totalGastos   = gastos.reduce((s, g) => s + (parseFloat(g.total) || 0), 0);
  const balance       = totalIngresos - totalGastos;
  const margen        = totalIngresos > 0 ? (balance / totalIngresos * 100) : 0;
  const balColor      = balance >= 0 ? "#16a34a" : "#dc2626";
  const balBg         = balance >= 0 ? "#f0fdf4" : "#fef2f2";
  const balBorder     = balance >= 0 ? "#bbf7d0" : "#fecaca";
  const cobradoBruto  = efectivo + debito + credito;

  // ── Cruce por día (usando ingreso neto por día) ──
  const diasMap = {};

  // Ingresos por día: recalculamos neto proporcionalmente
  // Cada venta única contribuye su porción neta (efectivo sin rebaja, debito/credito con rebaja)
  ventasFiltradas.forEach(v => {
    const d = v.fecha ? toDateStr(new Date(v.fecha)) : null;
    if (!d) return;
    if (!diasMap[d]) diasMap[d] = { ingresos: 0, gastos: 0 };

    let netoVenta = 0;
    if (v.pagos && typeof v.pagos === "object") {
      const ef = Math.max(parseFloat(v.pagos.efectivo) || 0, 0);
      const db = Math.max(parseFloat(v.pagos.debito)   || 0, 0);
      const cr = Math.max(parseFloat(v.pagos.credito)  || 0, 0);
      netoVenta = ef
        + db * (1 - IVA_REBAJA_DEBITO  / divisorIVA)
        + cr * (1 - IVA_REBAJA_CREDITO / divisorIVA);
    } else {
      const monto = Math.max(parseFloat(v.ventaTotal) || 0, 0);
      const m = String(v.metodo || "").toLowerCase();
      if (m === "debito")       netoVenta = monto * (1 - IVA_REBAJA_DEBITO  / divisorIVA);
      else if (m === "credito") netoVenta = monto * (1 - IVA_REBAJA_CREDITO / divisorIVA);
      else                      netoVenta = monto;
    }
    diasMap[d].ingresos += netoVenta;
  });

  gastos.forEach(g => {
    const d = g.fecha;
    if (!d) return;
    if (!diasMap[d]) diasMap[d] = { ingresos: 0, gastos: 0 };
    diasMap[d].gastos += parseFloat(g.total) || 0;
  });

  const dias = Object.entries(diasMap).sort((a, b) => a[0].localeCompare(b[0]));

  // ── Gráfica SVG barras (últimos 14 días) ──
  const chartDays = dias.slice(-14);
  const maxVal    = Math.max(...chartDays.flatMap(([, d]) => [d.ingresos, d.gastos]), 1);
  const barW = 10, gap = 3, groupW = barW * 2 + gap + 10;
  const chartW = Math.max(chartDays.length * groupW + 44, 280);
  const chartH = 80;

  const barsSVG = chartDays.map(([fecha, d], i) => {
    const x  = 32 + i * groupW;
    const hi = Math.max(Math.round((d.ingresos / maxVal) * chartH), d.ingresos > 0 ? 2 : 0);
    const hg = Math.max(Math.round((d.gastos   / maxVal) * chartH), d.gastos   > 0 ? 2 : 0);
    const label = fecha.slice(5).replace("-", "/");
    return `
      <rect x="${x}" y="${chartH - hi}" width="${barW}" height="${hi}" fill="#22c55e" rx="2" opacity=".9"/>
      <rect x="${x + barW + gap}" y="${chartH - hg}" width="${barW}" height="${hg}" fill="#ef4444" rx="2" opacity=".9"/>
      <text x="${x + barW}" y="${chartH + 14}" text-anchor="middle" font-size="7" fill="#94a3b8">${label}</text>`;
  }).join("");

  const svgChart = chartDays.length > 0 ? `
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
      <svg viewBox="0 0 ${chartW} ${chartH + 22}" style="width:100%;min-width:${chartW}px;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">
        <line x1="30" y1="0" x2="30" y2="${chartH}" stroke="#e2e8f0" stroke-width="1"/>
        <line x1="30" y1="${chartH}" x2="${chartW}" y2="${chartH}" stroke="#e2e8f0" stroke-width="1"/>
        ${barsSVG}
      </svg>
    </div>
    <div style="display:flex;gap:14px;font-size:11px;color:#64748b;padding:4px 2px 0;">
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#22c55e;border-radius:2px;display:inline-block;"></span>Ingresos netos</span>
      <span style="display:flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;background:#ef4444;border-radius:2px;display:inline-block;"></span>Gastos</span>
    </div>` : `<p style="font-size:13px;color:#94a3b8;padding:12px 0 4px;">Sin datos para graficar en este período.</p>`;

  // ── Tabla por día (desc) ──
  const diasDesc  = [...dias].reverse();
  const tablaRows = diasDesc.slice(0, 60).map(([fecha, d]) => {
    const bal   = d.ingresos - d.gastos;
    const color = bal >= 0 ? "#16a34a" : "#dc2626";
    const sign  = bal >= 0 ? "+" : "";
    const dd    = fecha.slice(8) + "/" + fecha.slice(5, 7);
    return `
      <div style="display:grid;grid-template-columns:56px 1fr 1fr 1fr;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border,#e2e8f0);font-size:12px;align-items:center;">
        <span style="color:#475569;font-weight:500;">${dd}</span>
        <span style="text-align:right;color:#16a34a;">${fmtUYU(d.ingresos)}</span>
        <span style="text-align:right;color:#dc2626;">${fmtUYU(d.gastos)}</span>
        <span style="text-align:right;font-weight:700;color:${color};">${sign}${fmtUYU(bal)}</span>
      </div>`;
  }).join("");

  content.innerHTML = `
    <!-- KPIs principales -->
    <div class="gr-summary-grid" style="grid-template-columns:1fr 1fr;gap:10px;">
      <div class="gr-summary-card" style="background:#f0fdf4;border:1px solid #bbf7d0;">
        <div class="gr-summary-label">💚 Ingresos netos</div>
        <div class="gr-summary-value" style="color:#16a34a;font-size:clamp(14px,4vw,20px);">${fmtUYU(totalIngresos)}</div>
        <div style="font-size:10px;color:#64748b;margin-top:3px;">cobrado ${fmtUYU(cobradoBruto)} · <span style="color:#ef4444;">−${fmtUYU(totalDescuentoIVA)} IVA ley</span></div>
      </div>
      <div class="gr-summary-card" style="background:#fef2f2;border:1px solid #fecaca;">
        <div class="gr-summary-label">🔴 Gastos</div>
        <div class="gr-summary-value" style="color:#dc2626;font-size:clamp(14px,4vw,20px);">${fmtUYU(totalGastos)}</div>
      </div>
      <div class="gr-summary-card" style="background:${balBg};border:1px solid ${balBorder};">
        <div class="gr-summary-label">⚖️ Balance neto</div>
        <div class="gr-summary-value" style="color:${balColor};font-size:clamp(14px,4vw,20px);">${balance >= 0 ? "+" : ""}${fmtUYU(balance)}</div>
      </div>
      <div class="gr-summary-card" style="background:${balBg};border:1px solid ${balBorder};">
        <div class="gr-summary-label">📈 Margen</div>
        <div class="gr-summary-value" style="color:${balColor};font-size:clamp(14px,4vw,20px);">${margen.toFixed(1)}%</div>
      </div>
    </div>

    <!-- Detalle IVA ley inclusión financiera -->
    <div class="gr-por-rubro-card" style="padding:12px 14px;">
      <h3 style="margin-bottom:10px;">Rebaja IVA · Ley inclusión financiera</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px;">
        <div style="background:#f8fafc;border-radius:8px;padding:10px;border:1px solid #e2e8f0;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Efectivo</div>
          <div style="font-weight:700;color:#0f172a;">${fmtUYU(efectivo)}</div>
          <div style="color:#94a3b8;font-size:10px;margin-top:2px;">sin rebaja</div>
        </div>
        <div style="background:#eff6ff;border-radius:8px;padding:10px;border:1px solid #bfdbfe;">
          <div style="color:#1d4ed8;font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Débito · ${IVA_REBAJA_DEBITO} pts</div>
          <div style="font-weight:700;color:#0f172a;">${fmtUYU(debitoNeto)}</div>
          <div style="color:#ef4444;font-size:10px;margin-top:2px;">−${fmtUYU(debitoDescuento)} IVA</div>
        </div>
        <div style="background:#f5f3ff;border-radius:8px;padding:10px;border:1px solid #ddd6fe;">
          <div style="color:#7c3aed;font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Crédito · ${IVA_REBAJA_CREDITO} pts</div>
          <div style="font-weight:700;color:#0f172a;">${fmtUYU(creditoNeto)}</div>
          <div style="color:#ef4444;font-size:10px;margin-top:2px;">−${fmtUYU(creditoDescuento)} IVA</div>
        </div>
      </div>
    </div>

    <!-- Gráfica de barras -->
    <div class="gr-por-rubro-card">
      <h3>Comparativa por día</h3>
      ${svgChart}
    </div>

    <!-- Tabla cruce diario -->
    ${dias.length > 0 ? `
    <div class="gr-table-card" style="padding:0;overflow:hidden;">
      <h3 style="padding:12px 14px 8px;margin:0;">Detalle por día</h3>
      <div style="display:grid;grid-template-columns:56px 1fr 1fr 1fr;gap:4px;padding:6px 12px;background:#f1f5f9;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">
        <span>Fecha</span>
        <span style="text-align:right;">Ing. neto</span>
        <span style="text-align:right;">Gastos</span>
        <span style="text-align:right;">Balance</span>
      </div>
      ${tablaRows}
      ${diasDesc.length > 60 ? `<p style="text-align:center;font-size:12px;color:#94a3b8;padding:8px 0;">Mostrando 60 de ${diasDesc.length} días</p>` : ""}
    </div>` : `
    <div class="report-empty">
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <p>No hay datos en el período seleccionado.</p>
    </div>`}
  `;
}
