CREATE POLICY "Usuarios autenticados pueden ver productos"
ON productos
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Usuarios autenticados pueden insertar productos"
ON productos
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Usuarios autenticados pueden actualizar productos"
ON productos
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);




CREATE POLICY "Usuarios autenticados pueden ver ventas"
ON ventas
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Usuarios autenticados pueden insertar ventas"
ON ventas
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Usuarios autenticados pueden actualizar ventas"
ON ventas
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);




CREATE POLICY "Usuarios autenticados pueden ver mesas"
ON mesas
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Usuarios autenticados pueden insertar mesas"
ON mesas
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Usuarios autenticados pueden actualizar mesas"
ON mesas
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);


CREATE POLICY "Usuarios autenticados pueden ver gastos"
ON gastos
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Usuarios autenticados pueden insertar gastos"
ON gastos
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Usuarios autenticados pueden actualizar gastos"
ON gastos
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);


CREATE POLICY "Usuarios autenticados pueden ver gastos_items"
ON gastos_items
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Usuarios autenticados pueden insertar gastos_items"
ON gastos_items
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Usuarios autenticados pueden actualizar gastos_items"
ON gastos_items
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);
-- ================================================================
-- CONTADOR DE VENTAS POR PRODUCTO
-- Ejecutar en el SQL Editor de Supabase
-- ================================================================

-- 1. Agregar la columna cantidad_ventas a productos
--    (el JS ya la usa para ordenar, así que el nombre debe ser exacto)
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS cantidad_ventas integer NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------
-- 2. Función del trigger
--    Se ejecuta cada vez que se inserta una fila en "ventas".
--    Recorre el array JSONB "items" y suma la cantidad vendida
--    de cada producto en productos.cantidad_ventas.
--    Ignora el ítem especial "descuento" (id = 'descuento').
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_incrementar_ventas_productos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
BEGIN
  -- NEW.items es un array JSONB como:
  -- [{ "id": "uuid...", "nombre": "Café", "cantidad": 2, ... }, ...]
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
  LOOP
    -- Saltar el ítem de descuento (id es texto 'descuento', no uuid)
    IF (item->>'id') = 'descuento' THEN
      CONTINUE;
    END IF;

    UPDATE public.productos
    SET cantidad_ventas = cantidad_ventas + (item->>'cantidad')::integer
    WHERE id = (item->>'id')::uuid;

  END LOOP;

  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------
-- 3. Crear el trigger (DROP primero para poder re-ejecutar el script)
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_incrementar_ventas ON public.ventas;

CREATE TRIGGER trg_incrementar_ventas
  AFTER INSERT ON public.ventas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_incrementar_ventas_productos();

-- ----------------------------------------------------------------
-- 4. (Opcional) Recalcular histórico desde ventas ya registradas
--    Ejecutar UNA sola vez si ya tenés ventas previas.
--    Podés saltear esto si la tabla ventas está vacía o
--    no te importa el historial anterior.
-- ----------------------------------------------------------------
/*
UPDATE public.productos p
SET cantidad_ventas = (
  SELECT COALESCE(SUM((item->>'cantidad')::integer), 0)
  FROM public.ventas v,
       jsonb_array_elements(v.items) AS item
  WHERE (item->>'id') != 'descuento'
    AND (item->>'id')::uuid = p.id
);
*/

-- ----------------------------------------------------------------
-- 5. Verificar
-- ----------------------------------------------------------------
SELECT id, nombre, cantidad_ventas
FROM public.productos
ORDER BY cantidad_ventas DESC;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS preferencias jsonb DEFAULT '{}';


create policy "usuario puede actualizar sus preferencias"
on public.usuarios
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

------------------------
-- TIPOS DE PAGO EN CARRITO
------------------------

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS pagos jsonb;

-- 2. Verificar que la columna se creó correctamente
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'ventas' AND column_name = 'pagos';