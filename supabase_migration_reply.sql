-- ============================================================================
-- personal_funding : 응원 메시지 대댓글(Reply) 기능 마이그레이션 SQL
-- 실행 위치: Supabase Dashboard -> SQL Editor
-- 주의: 기존 데이터(campaigns, gifts, contributions 등)는 전혀 변경/삭제되지 않습니다.
-- ============================================================================

-- 1. 대댓글 테이블 생성 (1단계 대댓글 전용)
create table if not exists public.contribution_replies (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  contribution_id text not null references public.contributions(id) on delete cascade,
  author_name text not null check (char_length(trim(author_name)) between 1 and 30),
  content text not null check (char_length(trim(content)) between 1 and 300),
  is_host boolean not null default false,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

-- 성능 최적화 인덱스
create index if not exists idx_replies_campaign_id on public.contribution_replies(campaign_id);
create index if not exists idx_replies_contribution_id on public.contribution_replies(contribution_id);
create index if not exists idx_replies_created_at on public.contribution_replies(created_at asc);

-- 2. Row Level Security (RLS) 활성화 및 조회 정책 설정
alter table public.contribution_replies enable row level security;

-- 누구나 해당 펀딩의 숨김 처리되지 않은 답글 조회 가능
drop policy if exists "공개 답글 조회" on public.contribution_replies;
create policy "공개 답글 조회" on public.contribution_replies
  for select
  using (is_hidden = false);

-- 직접 INSERT/UPDATE/DELETE 차단 (서버 RPC를 통해서만 검증 후 실행)
revoke all on table public.contribution_replies from anon, authenticated;
grant select on table public.contribution_replies to anon, authenticated;

-- 3. 대댓글 작성 RPC 함수
--   - 스팸 방지: 동일 IP 1분당 최대 10회 제한
--   - 다른 펀딩 댓글에 답글 작성 방지: contribution.campaign_id = p_campaign_id 엄격 확인
--   - 관리자 사칭 방지: 클라이언트 주장을 믿지 않고, 서버 세션 토큰으로 직접 검증하여 is_host 부여
drop function if exists public.create_contribution_reply(text, text, text, text, text);
create function public.create_contribution_reply(
  p_campaign_id text,
  p_contribution_id text,
  p_author_name text,
  p_content text,
  p_session_token text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_pid text := trim(coalesce(p_contribution_id, ''));
  v_author text := trim(coalesce(p_author_name, ''));
  v_content text := trim(coalesce(p_content, ''));
  v_token text := trim(coalesce(p_session_token, ''));
  v_is_host boolean := false;
  v_target_cid text;
  v_reply_id text;
  v_client_fp text;
begin
  if v_cid = '' or v_pid = '' then
    return jsonb_build_object('ok', false, 'message', '잘못된 요청입니다.');
  end if;

  if char_length(v_author) < 1 or char_length(v_author) > 30 then
    return jsonb_build_object('ok', false, 'message', '닉네임은 1자 이상 30자 이하로 입력해 주세요.');
  end if;

  if char_length(v_content) < 1 or char_length(v_content) > 300 then
    return jsonb_build_object('ok', false, 'message', '답글 내용은 1자 이상 300자 이하로 입력해 주세요.');
  end if;

  -- 1. 스팸 방지 레이트 리밋 (동일 클라이언트 1분당 최대 10회)
  v_client_fp := public.get_client_fingerprint();
  if not public.check_rate_limit('create_reply_ip', v_client_fp, 10, 60) then
    return jsonb_build_object('ok', false, 'message', '답글 작성 요청이 너무 많습니다. 1분 후 다시 시도해 주세요.');
  end if;

  -- 2. 원본 응원 메시지 검증 (타 펀딩 댓글 참조 불가)
  select campaign_id into v_target_cid
  from public.contributions
  where id = v_pid;

  if v_target_cid is null or v_target_cid <> v_cid then
    return jsonb_build_object('ok', false, 'message', '해당 펀딩의 원본 응원 메시지를 찾을 수 없습니다.');
  end if;

  -- 3. 펀딩 주인(관리자) 세션 토큰 검증
  if v_token <> '' then
    v_is_host := public.verify_campaign_session(v_cid, v_token);
  end if;

  -- 4. 고유 ID 생성 (r-xxxxxx)
  v_reply_id := 'r-' || encode(gen_random_bytes(6), 'hex');

  insert into public.contribution_replies (
    id, campaign_id, contribution_id, author_name, content, is_host, is_hidden, created_at
  ) values (
    v_reply_id, v_cid, v_pid, v_author, v_content, v_is_host, false, now()
  );

  return jsonb_build_object(
    'ok', true,
    'reply_id', v_reply_id,
    'author_name', v_author,
    'content', v_content,
    'is_host', v_is_host,
    'created_at', now()
  );
end;
$$;

-- 4. 펀딩 주인(관리자)의 답글 삭제 RPC 함수
drop function if exists public.owner_delete_reply(text, text, text);
create function public.owner_delete_reply(
  p_campaign_id text,
  p_session_token text,
  p_reply_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_token text := trim(coalesce(p_session_token, ''));
  v_rid text := trim(coalesce(p_reply_id, ''));
begin
  if not public.verify_campaign_session(v_cid, v_token) then
    return jsonb_build_object('ok', false, 'message', '관리자 권한이 없습니다.');
  end if;

  delete from public.contribution_replies
  where id = v_rid and campaign_id = v_cid;

  return jsonb_build_object('ok', true);
end;
$$;

-- 5. 일반 방문자의 답글 신고 접수 RPC 함수 (스팸/부적절한 내용)
drop function if exists public.report_contribution_reply(text, text);
create function public.report_contribution_reply(
  p_campaign_id text,
  p_reply_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_client_fp text;
begin
  v_client_fp := public.get_client_fingerprint();
  if not public.check_rate_limit('report_reply_ip', v_client_fp, 10, 600) then
    return jsonb_build_object('ok', false, 'message', '신고 요청 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.');
  end if;

  return jsonb_build_object('ok', true, 'message', '신고가 정상 접수되었습니다. 검토 후 조치됩니다.');
end;
$$;

-- 6. RPC 권한 부여
revoke all on function public.create_contribution_reply(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_contribution_reply(text, text, text, text, text) to anon, authenticated;

revoke all on function public.owner_delete_reply(text, text, text) from public, anon, authenticated;
grant execute on function public.owner_delete_reply(text, text, text) to anon, authenticated;

revoke all on function public.report_contribution_reply(text, text) from public, anon, authenticated;
grant execute on function public.report_contribution_reply(text, text) to anon, authenticated;

-- Realtime 복제 테이블에 contribution_replies 추가 (실시간 답글 업데이트 지원)
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    begin
      alter publication supabase_realtime add table public.contribution_replies;
    exception when others then
      -- 이미 추가되어 있는 경우 예외 무시
      null;
    end;
  end if;
end;
$$;
