/* ============================================================
   config.js  →  src/config.js
   Adaptado para Vite: las constantes se leen desde variables
   de entorno inyectadas en build time por import.meta.env
   
   Dev:   .env.development  (corre con `npm run dev`)
   Prod:  .env.production   (corre con `npm run build`)
   ============================================================ */

/* ========== GOOGLE APPS SCRIPT API ========== */
export const API_URL = import.meta.env.VITE_API_URL;

export function getAPI(ambiente = "desa") {
  // Mantenida idéntica a la original; en Vite el ambiente
  // ya viene seleccionado por el archivo .env correspondiente,
  // pero se conserva la función por compatibilidad con el resto del código.
  if (ambiente.toLowerCase() === "desa" || ambiente.toLowerCase() === "prod") {
    return API_URL;
  }
  return false;
}

/* ============ SUPABASE ============ */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

/* ========== MESAS ========== */
export const MESA_COUNT = Number(import.meta.env.VITE_MESA_COUNT) || 5;

export const MESAS_CONFIG = import.meta.env.VITE_MESAS_CONFIG
  ? import.meta.env.VITE_MESAS_CONFIG.split(",").map(s => s.trim())
  : ["Mesa 1", "Mesa 2", "Mesa 3", "Mesa 4", "Mostrador"];
