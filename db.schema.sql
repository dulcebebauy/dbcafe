-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.gastos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  empresa text,
  sucursal text,
  direccion text,
  rut text,
  tipo_documento text,
  numero_factura text,
  fecha date,
  hora time without time zone,
  moneda text NOT NULL DEFAULT 'UYU'::text,
  subtotal numeric,
  total numeric NOT NULL DEFAULT 0 CHECK (total >= 0::numeric),
  forma_pago jsonb DEFAULT '[]'::jsonb,
  impuestos jsonb DEFAULT '[]'::jsonb,
  descuentos jsonb DEFAULT '[]'::jsonb,
  observaciones text,
  json_original jsonb,
  usuario_username text,
  CONSTRAINT gastos_pkey PRIMARY KEY (id)
);
CREATE TABLE public.gastos_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  gasto_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  descripcion text,
  cantidad numeric DEFAULT 1,
  unidad text,
  precio_unitario numeric DEFAULT 0,
  subtotal numeric DEFAULT 0,
  rubro text,
  CONSTRAINT gastos_items_pkey PRIMARY KEY (id),
  CONSTRAINT gastos_items_gasto_id_fkey FOREIGN KEY (gasto_id) REFERENCES public.gastos(id)
);
CREATE TABLE public.mesas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  numero integer NOT NULL,
  nombre text,
  carrito jsonb DEFAULT '[]'::jsonb,
  subtotal numeric DEFAULT 0,
  descuento numeric DEFAULT 0,
  total numeric DEFAULT 0,
  metodo_pago text,
  mesa_cerrada boolean DEFAULT false,
  fecha_apertura timestamp with time zone DEFAULT now(),
  fecha_cierre timestamp with time zone,
  CONSTRAINT mesas_pkey PRIMARY KEY (id)
);
CREATE TABLE public.productos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  descripcion text,
  precio numeric NOT NULL,
  categoria text,
  activo boolean DEFAULT true,
  mostrar_carta boolean DEFAULT true,
  mostrar_precio_carta boolean NOT NULL DEFAULT true,
  cantidad_ventas integer NOT NULL DEFAULT 0,
  CONSTRAINT productos_pkey PRIMARY KEY (id)
);
CREATE TABLE public.usuarios (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  rol text NOT NULL CHECK (rol = ANY (ARRAY['mozo'::text, 'cajero'::text, 'administrador'::text])),
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  auth_user_id uuid UNIQUE,
  preferencias jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT usuarios_pkey PRIMARY KEY (id),
  CONSTRAINT usuarios_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.ventas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mesa_id uuid,
  items jsonb,
  subtotal numeric,
  descuento numeric,
  total numeric,
  metodo_pago text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ventas_pkey PRIMARY KEY (id),
  CONSTRAINT ventas_mesa_id_fkey FOREIGN KEY (mesa_id) REFERENCES public.mesas(id)
);