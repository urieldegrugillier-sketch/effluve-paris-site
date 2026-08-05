-- service_role was missing SELECT/INSERT/UPDATE/DELETE on public.profiles
-- (only had REFERENCES/TRIGGER/TRUNCATE -- compare to public.orders, which
-- already has the full set granted to service_role via an earlier
-- migration). Never surfaced before because no Edge Function did a
-- service-role query against profiles until mark-order-shipped's is_admin
-- check + first_name lookup -- both failed with "permission denied for
-- table profiles" until this grant was added.
grant select, insert, update, delete on public.profiles to service_role;
