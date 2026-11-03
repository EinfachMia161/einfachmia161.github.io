-- Undo from the change log, plus half strikes. Load after policies.sql.
-- Re-runnable: safe to apply to the live database on its own.

-- ===================================================================== half strikes
-- Strikes in steps of 0.5, up to 10 (0 stays allowed for imported entries).
alter table strike drop constraint if exists strike_weight_check;
alter table strike add constraint strike_weight_check
  check (weight >= 0 and weight <= 10 and weight * 2 = trunc(weight * 2));

-- ===================================================================== change log
-- tx groups the rows written by one action (e.g. adding a member writes person, alias and membership),
-- so one click undoes the whole action.
-- Added without a default first, so existing entries are not all grouped into one action.
alter table audit_log add column if not exists tx bigint;
alter table audit_log alter column tx set default txid_current();
alter table audit_log add column if not exists undone_at timestamptz;
alter table audit_log add column if not exists undone_by uuid;
create index if not exists audit_log_tx on audit_log (tx);

-- Officers must not see Regimental Command-only CO entries through the change log.
drop policy if exists "officer read" on audit_log;
create policy "officer read" on audit_log for select to authenticated
  using (public.is_officer() and (public.is_regcom()
         or (coalesce(old_data ->> 'visibility', '') <> 'regcom' and coalesce(new_data ->> 'visibility', '') <> 'regcom')));

-- Undo one action: every change it made is reverted, newest first, all or nothing.
-- A change is only reverted while the entry still looks exactly as the action left it,
-- so a later edit is never overwritten silently. The undo itself is logged and can be undone again.
create or replace function public.undo_change(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.audit_log;
  grp bigint[];
  rel regclass;
  aid bigint;
  pk text;
  cols text;
  vals text;
  cur jsonb;
  n int := 0;
begin
  if not public.is_officer() then
    raise exception 'Only signed-in officers can undo changes.' using errcode = '42501';
  end if;
  select * into a from public.audit_log where id = p_id;
  if not found or (not public.is_regcom() and 'regcom' in (coalesce(a.old_data ->> 'visibility', ''),
                                                           coalesce(a.new_data ->> 'visibility', ''))) then
    return jsonb_build_object('ok', false, 'message', 'Change not found.');
  end if;

  select array_agg(id order by id desc) into grp from (
    select id from public.audit_log
    where id = p_id or (a.tx is not null and tx = a.tx)
    for update) g;
  if exists (select 1 from public.audit_log where id = any(grp) and undone_at is not null) then
    return jsonb_build_object('ok', false, 'message', 'This action was already undone.');
  end if;
  if exists (select 1 from public.audit_log where id = any(grp)
             and (table_name in ('officer_account', 'co_document')
                  or (not public.is_regcom() and 'regcom' in (coalesce(old_data ->> 'visibility', ''),
                                                               coalesce(new_data ->> 'visibility', ''))))) then
    return jsonb_build_object('ok', false, 'message',
      'Officer logins and uploaded documents cannot be undone here; change them in the CO area.');
  end if;

  begin
    foreach aid in array grp loop
      select * into a from public.audit_log where id = aid;
      rel := format('public.%I', a.table_name)::regclass;
      select string_agg(format('t.%1$I = r.%1$I', att.attname), ' and ') into pk
        from pg_index i join pg_attribute att on att.attrelid = i.indrelid and att.attnum = any(i.indkey)
        where i.indrelid = rel and i.indisprimary;
      execute format('select to_jsonb(t) from %s t, jsonb_populate_record(null::%s, $1) r where %s for update of t',
                     rel, rel, pk) into cur using coalesce(a.new_data, a.old_data);

      if a.action = 'DELETE' then
        if cur is not null then
          raise exception using errcode = 'P0001', message = 'The deleted entry exists again.';
        end if;
        execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', rel, rel) using a.old_data;
      else
        if cur is null then
          raise exception using errcode = 'P0001', message = 'The entry was deleted since.';
        elsif not cur @> a.new_data then
          raise exception using errcode = 'P0001',
            message = 'The entry was changed again since. Undo the newer change first.';
        end if;
        if a.action = 'INSERT' then
          if a.table_name = 'person' and exists (select 1 from public.officer_account where person_id = (a.new_data ->> 'id')::uuid) then
            raise exception using errcode = 'P0001', message = 'This person has an officer login. Remove it first.';
          end if;
          execute format('delete from %s t using jsonb_populate_record(null::%s, $1) r where %s', rel, rel, pk)
            using a.new_data;
        else
          select string_agg(quote_ident(attname), ', ' order by attnum),
                 string_agg('o.' || quote_ident(attname), ', ' order by attnum) into cols, vals
            from pg_attribute where attrelid = rel and attnum > 0 and not attisdropped and a.old_data ? attname;
          execute format('update %s t set (%s) = (select %s from jsonb_populate_record(null::%s, $1) o) '
                         'from jsonb_populate_record(null::%s, $2) r where %s',
                         rel, cols, vals, rel, rel, pk) using a.old_data, a.new_data;
        end if;
      end if;
      n := n + 1;
    end loop;
  exception
    when sqlstate 'P0001' then
      return jsonb_build_object('ok', false, 'message', sqlerrm);
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'message', 'Other entries depend on this one. Undo or remove those first.');
    when unique_violation then
      return jsonb_build_object('ok', false, 'message', 'An entry with the same key exists already.');
    when check_violation or not_null_violation then
      return jsonb_build_object('ok', false, 'message', 'The old values are not allowed any more.');
  end;

  update public.audit_log set undone_at = now(), undone_by = auth.uid() where id = any(grp);
  return jsonb_build_object('ok', true, 'message', case when n = 1 then 'Change undone.' else n || ' changes undone.' end);
end $$;

revoke all on function public.undo_change(bigint) from public, anon, authenticated;
grant execute on function public.undo_change(bigint) to authenticated;
