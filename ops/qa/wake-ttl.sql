-- QA ONLY. Install after ops/cron/supabase-wake.example.sql and ops/qa/limits.sql.
-- The approved operator schedules this ROOT function once/minute only after the QA binding is ready.
begin;
do $$ begin
 if to_regclass('public.sokupa_qa_bootstrap') is null then raise exception 'qa_bootstrap_required';end if;
 if not exists(select 1 from public.sokupa_qa_bootstrap where singleton and version=1) then raise exception 'qa_bootstrap_required';end if;
end $$;
create function public.sokupa_qa_tick() returns void language plpgsql security invoker set search_path='' as $$
declare expiry timestamptz;started timestamptz;j bigint;
begin
  select issued_at,expires_at into started,expiry from public.sokupa_qa_limits where singleton;
  if expiry is null or started>clock_timestamp() or expiry<=clock_timestamp() then
    perform public.configure_analysis_wake(false,null,false);
    perform public.set_analysis_execution_mode('disabled');
    -- Keep the disabled state if unscheduling temporarily fails. No more HTTP is enqueued.
    begin
      for j in select jobid from cron.job where jobname='sokupa-iphone-qa-ttl' loop perform cron.unschedule(j);end loop;
    exception when others then raise warning 'qa_cron_unschedule_failed';end;
    return;
  end if;
  perform sokupa_wake_ops.reconcile();
  perform sokupa_wake_ops.enqueue();
end $$;
revoke all on function public.sokupa_qa_tick() from public,anon,authenticated,service_role;
commit;
-- No schedule is created by this file. Approved operator, QA DB only:
-- select cron.schedule('sokupa-iphone-qa-ttl','* * * * *','select public.sokupa_qa_tick()');
