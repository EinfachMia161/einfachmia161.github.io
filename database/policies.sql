-- Access rules for the TEST site.
-- Everyone (anon key) can read everything and edit the roster tables the site uses.
-- Nothing can be hard-deleted except log entries and requirement ticks, and every change lands in audit_log.
-- Before real use: replace the anon write policies with ones for signed-in officers (Discord login).

-- Start from no rights at all: Supabase grants anon full table rights by default.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function app_today() to anon, authenticated;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select on %I to anon, authenticated', t);
    execute format('create policy "read for everyone" on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

grant select on v_roster, v_promotion_board, v_overview, v_active_blacklist to anon, authenticated;

do $$
declare t text;
begin
  -- insert + update
  foreach t in array array['person','person_alias','membership','member_requirement','requirement',
                           'person_qualification','duty_log','strike','leave','rank_change',
                           'blacklist','blacklist_appeal'] loop
    execute format('grant insert, update on %I to anon, authenticated', t);
    execute format('create policy "test site insert" on %I for insert to anon, authenticated with check (true)', t);
    execute format('create policy "test site update" on %I for update to anon, authenticated using (true) with check (true)', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function audit_change()', t);
  end loop;
  -- delete (logs and ticks only)
  foreach t in array array['member_requirement','person_qualification','duty_log','strike','leave'] loop
    execute format('grant delete on %I to anon, authenticated', t);
    execute format('create policy "test site delete" on %I for delete to anon, authenticated using (true)', t);
  end loop;
end $$;

grant usage on all sequences in schema public to anon, authenticated;

grant execute on function change_rank(uuid, text, text, text, text), add_member(text, text, text, text, boolean),
  discharge_member(uuid, text, text, text), app_today() to anon, authenticated;
