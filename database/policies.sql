-- Access rules. Load after security.sql.
--   anon          = anyone with the website (publishable key)
--   authenticated = anyone with a Supabase login; edits additionally need public.is_officer()
-- Start from no rights at all: Supabase grants the API roles full rights by default.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- Public reading (everything except logins, the change log and Discord names)
  for t in select tablename from pg_tables where schemaname = 'public'
           and tablename not in ('person', 'officer_account', 'audit_log') loop
    execute format('grant select on %I to anon, authenticated', t);
    execute format('create policy "public read" on %I for select to anon, authenticated using (true)', t);
  end loop;

  -- Officer edits
  foreach t in array array['person','person_alias','membership','member_requirement','requirement',
                           'person_qualification','duty_log','strike','leave','rank_change',
                           'blacklist','blacklist_appeal'] loop
    execute format('grant insert, update on %I to authenticated', t);
    execute format('create policy "officer insert" on %I for insert to authenticated with check (public.is_officer())', t);
    execute format('create policy "officer update" on %I for update to authenticated using (public.is_officer()) with check (public.is_officer())', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function audit_change()', t);
  end loop;
  foreach t in array array['member_requirement','person_qualification','duty_log','strike','leave'] loop
    execute format('grant delete on %I to authenticated', t);
    execute format('create policy "officer delete" on %I for delete to authenticated using (public.is_officer())', t);
  end loop;
end $$;

-- person: Discord usernames are not readable through the API (officers get them from member_discord()).
grant select (id, steam_id, display_name, created_at) on person to anon, authenticated;
create policy "public read" on person for select to anon, authenticated using (true);
revoke insert, update on person from authenticated;
grant update (display_name, discord_username) on person to authenticated;

-- Officer logins: you see your own link; officers see all; Regimental Command can remove links.
grant select, delete on officer_account to authenticated;
create policy "own or officer" on officer_account for select to authenticated
  using (user_id = auth.uid() or public.is_officer());
create policy "regcom removes" on officer_account for delete to authenticated using (public.is_regcom());
create trigger audit after insert or update or delete on officer_account for each row execute function audit_change();

-- Change log: officers only, read-only for everyone.
grant select on audit_log to authenticated;
create policy "officer read" on audit_log for select to authenticated using (public.is_officer());

grant usage on all sequences in schema public to authenticated;
grant select on v_roster, v_promotion_board, v_overview, v_active_blacklist to anon, authenticated;

-- Functions
grant execute on function app_today(), is_officer(), is_regcom(), submit_duty(text, text, date, numeric, text)
  to anon, authenticated;
grant execute on function my_officer(), claim_officer(text, text), member_discord(),
  change_rank(uuid, text, text, text, text), add_member(text, text, text, text, boolean),
  discharge_member(uuid, text, text, text) to authenticated;
