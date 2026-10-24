-- ============================================================================
-- personal_funding — 다중 사용자 생일 선물 위시리스트 & 펀딩 플랫폼 Supabase 전체 스키마
--
-- 공식 서비스명 : personal_funding
-- 실행 대상     : 새 개발용 Supabase 프로젝트 [personal_funding] 전용
--                 ※ 기존 조소현 운영 프로젝트(bokjhtujnatxjvkpejks)에서는 절대 실행하지 마세요.
-- 실행 방법     : SQL Editor -> New query -> 이 파일 전체(Ctrl+A)를 붙여넣기
--                 -> 텍스트를 아무것도 선택(드래그)하지 않은 상태에서 [Run] 클릭
-- 재실행 안전성 : 이미 생성된 테이블과 기존 데이터를 삭제하지 않고 안전하게 재실행 가능합니다.
--                 (DROP TABLE / TRUNCATE / 무분별한 CASCADE 미사용, 트랜잭션 보장)
--
-- 실행 순서     : 0) 확장  1) 테이블 생성  2) RLS 및 정책  3) 함수 생성
--                 4) 권한 설정  5) Storage 버킷·정책  6) Realtime 설정
-- ============================================================================

begin;

-- ============================================================================
-- 0. 확장 (Supabase는 pgcrypto를 extensions 스키마에 설치합니다)
-- ============================================================================
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1. 테이블 생성 (기존 테이블·데이터 보존)
-- ============================================================================

-- (1) 공개 캠페인(펀딩 페이지) 정보
create table if not exists public.campaigns (
  id text primary key check (char_length(trim(id)) between 4 and 64),
  host_name text not null check (char_length(trim(host_name)) between 1 and 30),
  emoji text not null default '🎂',
  birthday_date text not null default '',
  headline text not null default '',
  subtitle text not null default '소중한 마음을 모으는 생일 위시리스트',
  bio text not null default '',
  bank_name text not null default '',
  bank_account text not null default '',
  kakao_remit_url text not null default '',
  toss_remit_url text not null default '',
  intro_image_url text not null default '',
  intro_image_fit text not null default 'cover' check (intro_image_fit in ('cover', 'contain')),
  pending_delete_image_url text not null default '',
  event_type text not null default 'birthday',
  intro_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- (2) [비공개] 펀딩 주인 비밀번호 해시 + 로그인 실패 잠금 + 안전 복구 코드 해시
--     비밀번호 복구/초기화 기능 대신, 생성 시 1회 발급되는 안전 복구 코드(해시 저장)로 펀딩 링크 조회를 지원합니다.
create table if not exists public.campaign_secrets (
  campaign_id text primary key references public.campaigns(id) on delete cascade,
  password_hash text not null,
  recovery_code_hash text,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

-- 기존 데이터베이스 마이그레이션 호환
alter table public.campaign_secrets add column if not exists recovery_code_hash text;
create index if not exists idx_campaign_secrets_recovery_hash on public.campaign_secrets(recovery_code_hash) where recovery_code_hash is not null;

-- (3) [비공개] 펀딩 주인 세션 토큰 (토큰 원문이 아닌 SHA-256 해시만 저장)
create table if not exists public.campaign_sessions (
  token_hash text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaign_sessions_campaign_id on public.campaign_sessions(campaign_id);
create index if not exists idx_campaign_sessions_expires_at on public.campaign_sessions(expires_at);

-- (4) 공개 위시리스트 선물 (campaign_id로 펀딩별 완전 분리)
create table if not exists public.gifts (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  category text not null default 'fashion',
  priority integer not null default 1 check (priority between 1 and 5),
  title text not null check (char_length(trim(title)) between 1 and 80),
  brand text not null default '',
  goal_amount integer not null check (goal_amount >= 1000 and goal_amount <= 100000000),
  description text not null default '',
  image_url text not null default '',
  image_fit text not null default 'cover' check (image_fit in ('cover', 'contain')),
  product_url text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_gifts_campaign_id on public.gifts(campaign_id);

-- (5) 공개 참여 내역 / 축하 메시지 (campaign_id로 펀딩별 완전 분리)
create table if not exists public.contributions (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  gift_id text not null references public.gifts(id) on delete cascade,
  sender_name text not null check (char_length(trim(sender_name)) between 1 and 30),
  relation text not null default '친구' check (char_length(trim(relation)) <= 24),
  amount integer not null check (amount >= 1000 and amount <= 50000000),
  message text not null check (char_length(trim(message)) between 1 and 300),
  avatar_url text not null default '',
  theme text not null default 'warm-cream',
  status text not null default 'pending' check (status in ('pending', 'approved')),
  cheers integer not null default 0 check (cheers >= 0),
  created_at_label text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_contributions_campaign_id on public.contributions(campaign_id);
create index if not exists idx_contributions_gift_id on public.contributions(gift_id);

-- (6) [비공개] 참여자 프로필 사진 수정용 PIN 해시 + 실패 잠금
create table if not exists public.contribution_secrets (
  contribution_id text primary key references public.contributions(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

-- (7) [비공개] 레이트 리밋 카운터
create table if not exists public.rate_limit_logs (
  bucket_key text primary key,
  hit_count integer not null default 0,
  window_start timestamptz not null default now()
);

-- (8) 공개 대댓글 (1단계 답글 전용)
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

create index if not exists idx_replies_campaign_id on public.contribution_replies(campaign_id);
create index if not exists idx_replies_contribution_id on public.contribution_replies(contribution_id);
create index if not exists idx_replies_created_at on public.contribution_replies(created_at asc);

-- ============================================================================
-- 2. RLS 활성화 및 공개 조회 정책
--    비공개 테이블 4개(campaign_secrets, campaign_sessions, contribution_secrets,
--    rate_limit_logs)는 정책을 만들지 않아 외부에서 직접 조회·수정이 불가능합니다.
-- ============================================================================
alter table public.campaigns enable row level security;
alter table public.campaign_secrets enable row level security;
alter table public.campaign_sessions enable row level security;
alter table public.gifts enable row level security;
alter table public.contributions enable row level security;
alter table public.contribution_replies enable row level security;
alter table public.contribution_secrets enable row level security;
alter table public.rate_limit_logs enable row level security;

drop policy if exists "campaigns_public_select" on public.campaigns;
create policy "campaigns_public_select"
  on public.campaigns for select
  to anon, authenticated
  using (true);

drop policy if exists "gifts_public_select" on public.gifts;
create policy "gifts_public_select"
  on public.gifts for select
  to anon, authenticated
  using (true);

drop policy if exists "contributions_public_select" on public.contributions;
create policy "contributions_public_select"
  on public.contributions for select
  to anon, authenticated
  using (true);

drop policy if exists "replies_public_select" on public.contribution_replies;
create policy "replies_public_select"
  on public.contribution_replies for select
  to anon, authenticated
  using (is_hidden = false);

-- ============================================================================
-- 3. 함수 생성
--    의존성 역순으로 기존 함수를 정리한 뒤 내부 헬퍼 함수 -> 공개 RPC 순으로 생성합니다.
--    모든 SECURITY DEFINER 함수는 search_path = public, extensions, pg_temp 로 고정합니다.
-- ============================================================================
drop function if exists public.create_contribution_reply(text, text, text, text, text);
drop function if exists public.owner_delete_reply(text, text, text);
drop function if exists public.report_contribution_reply(text, text);
drop function if exists public.owner_confirm_intro_deleted(text, text, text);
drop function if exists public.owner_set_intro_photo(text, text, text, text);
drop function if exists public.increment_contribution_cheer(text, integer);
drop function if exists public.manage_own_avatar(text, text, text, text, text);
drop function if exists public.create_pending_contribution(text, text, text, text, integer, text, text, text, text, text, text);
drop function if exists public.owner_reset_contributions(text, text);
drop function if exists public.owner_delete_contribution(text, text, text);
drop function if exists public.owner_set_contribution_status(text, text, text, text);
drop function if exists public.owner_delete_gift(text, text, text);
drop function if exists public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text, text);
drop function if exists public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text);
drop function if exists public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.logout_campaign_owner(text, text);
drop function if exists public.login_campaign_owner(text, text);
drop function if exists public.lookup_campaign_by_recovery_code(text);
drop function if exists public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.owner_check_session(text, text);
drop function if exists public.verify_campaign_session(text, text);
drop function if exists public.check_rate_limit(text, text, integer, integer);
drop function if exists public.get_client_fingerprint();

-- ---------------------------------------------------------------------------
-- 3-A. [내부 전용] 헬퍼 함수 — anon/authenticated 실행 권한 부여 안 함
-- ---------------------------------------------------------------------------

-- PostgREST request.headers 기반 클라이언트 식별 해시
-- (cf-connecting-ip, x-real-ip, x-forwarded-for 첫 번째 IP 및 user-agent 조합)
create function public.get_client_fingerprint()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_headers jsonb;
  v_ip text;
  v_ua text;
begin
  begin
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then
    v_headers := '{}'::jsonb;
  end;

  v_ip := trim(split_part(
    coalesce(
      nullif(trim(v_headers ->> 'cf-connecting-ip'), ''),
      nullif(trim(v_headers ->> 'x-real-ip'), ''),
      nullif(trim(v_headers ->> 'x-forwarded-for'), ''),
      'unknown-ip'
    ),
    ',',
    1
  ));
  v_ua := substr(coalesce(v_headers ->> 'user-agent', 'unknown-ua'), 1, 100);

  return encode(digest('pf-rl-fp-v1::' || v_ip || '::' || v_ua, 'sha256'), 'hex');
end;
$$;

-- 레이트 리밋 검사 (허용이면 카운트 +1 후 true, 초과면 false)
create function public.check_rate_limit(
  p_action text,
  p_scope_key text,
  p_max_hits integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_key text := p_action || '::' || coalesce(p_scope_key, 'global');
  v_now timestamptz := now();
  v_count integer;
  v_start timestamptz;
begin
  delete from public.rate_limit_logs
  where window_start < v_now - interval '2 hours';

  insert into public.rate_limit_logs (bucket_key, hit_count, window_start)
  values (v_key, 0, v_now)
  on conflict (bucket_key) do nothing;

  select hit_count, window_start
    into v_count, v_start
  from public.rate_limit_logs
  where bucket_key = v_key
  for update;

  if v_start + make_interval(secs => p_window_seconds) < v_now then
    update public.rate_limit_logs
    set hit_count = 1, window_start = v_now
    where bucket_key = v_key;
    return true;
  end if;

  if v_count >= p_max_hits then
    return false;
  end if;

  update public.rate_limit_logs
  set hit_count = hit_count + 1
  where bucket_key = v_key;

  return true;
end;
$$;

-- 펀딩 주인 세션 토큰 검증 (내부 전용)
--   매개변수: p_campaign_id text, p_session_token text  /  반환: boolean
create function public.verify_campaign_session(
  p_campaign_id text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_hash text;
  v_valid boolean;
begin
  if p_campaign_id is null or p_session_token is null or char_length(trim(p_session_token)) < 16 then
    return false;
  end if;

  delete from public.campaign_sessions
  where expires_at < now();

  v_token_hash := encode(digest('bday-session-v1::' || trim(p_session_token), 'sha256'), 'hex');

  select exists (
    select 1
    from public.campaign_sessions
    where token_hash = v_token_hash
      and campaign_id = trim(p_campaign_id)
      and expires_at > now()
  ) into v_valid;

  return coalesce(v_valid, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3-B. [공개 RPC] 펀딩 생성 · 로그인 · 로그아웃 · 세션 확인
-- ---------------------------------------------------------------------------

-- 브라우저용 세션 유효성 확인 (내부 verify_campaign_session을 감싼 공개 함수)
create function public.owner_check_session(
  p_campaign_id text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return public.verify_campaign_session(p_campaign_id, p_session_token);
end;
$$;

-- 새 펀딩 생성 (이름 + 관리 비밀번호 8자 이상, 고유 ID와 세션 토큰 반환)
--   레이트 리밋 카운터가 트랜잭션 롤백으로 유실되지 않도록 실패 시에도
--   예외(RAISE EXCEPTION) 대신 {ok:false, message} JSON을 반환합니다.
create function public.create_funding_campaign(
  p_host_name text,
  p_password text,
  p_birthday_date text default '',
  p_emoji text default '🎂',
  p_headline text default '',
  p_subtitle text default '',
  p_bio text default '',
  p_bank_name text default '',
  p_bank_account text default '',
  p_kakao_remit_url text default '',
  p_toss_remit_url text default '',
  p_honeypot text default '',
  p_event_type text default 'birthday',
  p_intro_message text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_clean_name text := trim(coalesce(p_host_name, ''));
  v_clean_pw text := trim(coalesce(p_password, ''));
  v_client_fp text;
  v_campaign_id text;
  v_headline text;
  v_subtitle text;
  v_bio text;
  v_bday text;
  v_event_type text := lower(trim(coalesce(p_event_type, 'birthday')));
  v_intro_msg text := trim(coalesce(p_intro_message, ''));
  v_event_label text;
  v_raw_token text;
  v_recovery_code text;
  v_rc_hash text;
begin
  if coalesce(p_honeypot, '') <> '' then
    return jsonb_build_object('ok', false, 'message', '비정상적인 요청이 감지되었습니다.');
  end if;

  if char_length(v_clean_name) < 1 or char_length(v_clean_name) > 30 then
    return jsonb_build_object('ok', false, 'message', '생일 주인공 이름은 1자 이상 30자 이하로 입력해 주세요.');
  end if;

  if char_length(v_clean_pw) < 8 or char_length(v_clean_pw) > 64 then
    return jsonb_build_object('ok', false, 'message', '관리 비밀번호는 8자 이상 64자 이하로 설정해 주세요.');
  end if;

  if v_event_type not in ('birthday', 'graduation', 'wedding', 'employment', 'admission', 'custom') then
    v_event_type := 'birthday';
  end if;

  case v_event_type
    when 'graduation' then v_event_label := '졸업';
    when 'wedding' then v_event_label := '결혼';
    when 'employment' then v_event_label := '입사';
    when 'admission' then v_event_label := '입학';
    when 'custom' then v_event_label := coalesce(nullif(v_intro_msg, ''), '축하');
    else v_event_label := '생일';
  end case;

  -- 대량 펀딩 생성 방지: 동일 클라이언트 10분당 5개, 전체 1분당 30개
  v_client_fp := public.get_client_fingerprint();
  if not public.check_rate_limit('create_campaign_ip', v_client_fp, 5, 600) then
    return jsonb_build_object('ok', false, 'message', '단시간에 너무 많은 펀딩을 생성할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  end if;
  if not public.check_rate_limit('create_campaign_global', 'all', 30, 60) then
    return jsonb_build_object('ok', false, 'message', '현재 생성 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  end if;

  loop
    v_campaign_id := 'f-' || encode(gen_random_bytes(5), 'hex');
    exit when not exists (select 1 from public.campaigns where id = v_campaign_id);
  end loop;

  v_bday := coalesce(nullif(trim(coalesce(p_birthday_date, '')), ''), to_char(now(), 'YYYY-MM-DD'));
  v_headline := coalesce(nullif(trim(coalesce(p_headline, '')), ''), v_clean_name || '의 ' || v_event_label || ' 선물 펀딩');
  v_subtitle := coalesce(nullif(trim(coalesce(p_subtitle, '')), ''), '소중한 마음을 모으는 ' || v_event_label || ' 위시리스트');
  v_bio := coalesce(
    nullif(trim(coalesce(p_bio, '')), ''),
    v_clean_name || '님이 받고 싶은 위시리스트에 원하는 금액만큼 마음을 보태주세요. 송금 후 「송금했어요」를 눌러주시면 입금 확인을 거쳐 달성률에 반영됩니다.'
  );

  insert into public.campaigns (
    id, host_name, emoji, birthday_date, headline, subtitle, bio,
    bank_name, bank_account, kakao_remit_url, toss_remit_url,
    event_type, intro_message
  ) values (
    v_campaign_id,
    v_clean_name,
    coalesce(nullif(trim(coalesce(p_emoji, '')), ''), case v_event_type
      when 'graduation' then '🎓'
      when 'wedding' then '💍'
      when 'employment' then '💼'
      when 'admission' then '🎒'
      when 'custom' then '🎉'
      else '🎂'
    end),
    v_bday,
    v_headline,
    v_subtitle,
    v_bio,
    trim(coalesce(p_bank_name, '')),
    trim(coalesce(p_bank_account, '')),
    trim(coalesce(p_kakao_remit_url, '')),
    trim(coalesce(p_toss_remit_url, '')),
    v_event_type,
    v_intro_msg
  );

  -- 고유하고 추측 불가능한 80비트 엔트로피 안전 복구 코드 발급 (원문은 단 1회 사용자에게만 반환)
  -- DB에는 솔트 네임스페이스가 적용된 SHA-256 해시값만 저장
  v_recovery_code := 'RC-' ||
    upper(encode(gen_random_bytes(2), 'hex')) || '-' ||
    upper(encode(gen_random_bytes(2), 'hex')) || '-' ||
    upper(encode(gen_random_bytes(2), 'hex')) || '-' ||
    upper(encode(gen_random_bytes(2), 'hex'));
  v_rc_hash := encode(digest('bday-rc-v1::' || v_recovery_code, 'sha256'), 'hex');

  insert into public.campaign_secrets (campaign_id, password_hash, recovery_code_hash)
  values (v_campaign_id, crypt(v_clean_pw, gen_salt('bf', 10)), v_rc_hash);

  insert into public.gifts (id, campaign_id, category, priority, title, brand, goal_amount, description, image_url, image_fit)
  values
    (v_campaign_id || '-gift-1', v_campaign_id, 'fashion', 1,
     v_clean_name || '의 1순위 위시 선물', '관리자 모드에서 사진·이름·금액 수정 가능', 250000,
     '[✏️ 사진·내용 수정] 버튼을 눌러 받고 싶은 실제 선물 사진과 목표 금액을 등록해 보세요.', '', 'cover'),
    (v_campaign_id || '-gift-2', v_campaign_id, 'fragrance', 2,
     v_clean_name || '의 2순위 위시 선물', '뷰티 / 향수 / 리빙 위시템', 150000,
     '원하는 선물 사진을 업로드하거나 목표 금액과 설명을 자유롭게 수정할 수 있습니다.', '', 'cover'),
    (v_campaign_id || '-gift-3', v_campaign_id, 'cake', 3,
     v_clean_name || ' ' || v_event_label || ' 축하 선물 & 꽃다발', v_event_label || ' 기념 스페셜', 70000,
     v_event_label || '를 더욱 빛내줄 축하 선물 모금입니다.', '', 'cover');

  v_raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.campaign_sessions (token_hash, campaign_id, expires_at)
  values (
    encode(digest('bday-session-v1::' || v_raw_token, 'sha256'), 'hex'),
    v_campaign_id,
    now() + interval '24 hours'
  );

  return jsonb_build_object(
    'ok', true,
    'campaign_id', v_campaign_id,
    'session_token', v_raw_token,
    'recovery_code', v_recovery_code
  );
end;
$$;

-- 펀딩 주인 로그인
--   실패 횟수/잠금/레이트 리밋 기록이 롤백되지 않도록, 실패 시 예외 대신
--   {ok:false, message} 를 반환합니다. (5회 연속 실패 시 15분 잠금)
create function public.login_campaign_owner(
  p_campaign_id text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_pw text := trim(coalesce(p_password, ''));
  v_secret record;
  v_raw_token text;
  v_remaining_mins integer;
begin
  if v_cid = '' or v_pw = '' then
    return jsonb_build_object('ok', false, 'message', '관리 비밀번호를 입력해 주세요.');
  end if;

  -- 동일 클라이언트의 펀딩별 로그인 시도 제한 (5분당 12회)
  if not public.check_rate_limit('login_owner_ip::' || v_cid, public.get_client_fingerprint(), 12, 300) then
    return jsonb_build_object('ok', false, 'message', '로그인 시도가 너무 많습니다. 5분 후 다시 시도해 주세요.');
  end if;

  select campaign_id, password_hash, failed_attempts, locked_until
    into v_secret
  from public.campaign_secrets
  where campaign_id = v_cid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', '존재하지 않는 펀딩입니다.');
  end if;

  if v_secret.locked_until is not null and v_secret.locked_until > now() then
    v_remaining_mins := greatest(1, ceil(extract(epoch from (v_secret.locked_until - now())) / 60.0)::integer);
    return jsonb_build_object(
      'ok', false,
      'message', format('비밀번호 5회 연속 오류로 관리 로그인이 잠겼습니다. 약 %s분 후에 다시 시도해 주세요.', v_remaining_mins)
    );
  end if;

  if v_secret.password_hash <> crypt(v_pw, v_secret.password_hash) then
    if v_secret.failed_attempts + 1 >= 5 then
      update public.campaign_secrets
      set failed_attempts = 0,
          locked_until = now() + interval '15 minutes'
      where campaign_id = v_cid;
      return jsonb_build_object('ok', false, 'message', '비밀번호를 5회 연속 틀려 15분간 관리 로그인이 잠겼습니다.');
    end if;

    update public.campaign_secrets
    set failed_attempts = failed_attempts + 1,
        locked_until = null
    where campaign_id = v_cid;
    return jsonb_build_object(
      'ok', false,
      'message', format('관리 비밀번호가 일치하지 않습니다. (남은 시도 횟수: %s회)', 5 - (v_secret.failed_attempts + 1))
    );
  end if;

  update public.campaign_secrets
  set failed_attempts = 0,
      locked_until = null
  where campaign_id = v_cid;

  v_raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.campaign_sessions (token_hash, campaign_id, expires_at)
  values (
    encode(digest('bday-session-v1::' || v_raw_token, 'sha256'), 'hex'),
    v_cid,
    now() + interval '24 hours'
  );

  return jsonb_build_object('ok', true, 'session_token', v_raw_token);
end;
$$;

-- 펀딩 복구 코드로 펀딩 링크 및 기본 정보 조회
--   - 이름/비밀번호만으로는 조회가 불가능하며, 80비트 고유 복구 코드 해시 일치 시에만 동작합니다.
--   - 무차별 대입 방지: 동일 클라이언트 10분당 5회 실패 제한 (check_rate_limit)
--   - 반환 데이터: 펀딩 고유 ID, 제목, 주인공 이름, 이벤트 유형 (관리자 권한 세션 토큰은 절대 반환하지 않음)
create function public.lookup_campaign_by_recovery_code(
  p_recovery_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_raw_code text := upper(trim(coalesce(p_recovery_code, '')));
  v_clean_code text;
  v_rc_hash text;
  v_client_fp text;
  v_campaign_id text;
  v_campaign record;
begin
  if v_raw_code = '' then
    return jsonb_build_object('ok', false, 'message', '복구 코드를 입력해 주세요.');
  end if;

  -- 무차별 대입 방지: 동일 IP/지문 기준 10분당 최대 5회 실패 제한
  v_client_fp := public.get_client_fingerprint();
  if not public.check_rate_limit('lookup_rc_ip', v_client_fp, 5, 600) then
    return jsonb_build_object(
      'ok', false,
      'message', '복구 코드 조회 시도 횟수를 초과했습니다. 10분 후 다시 시도해 주세요.'
    );
  end if;

  -- 영문/숫자만 추출 후 RC-XXXX-XXXX-XXXX-XXXX 표준 형식 정규화
  v_clean_code := regexp_replace(v_raw_code, '[^A-Z0-9]', '', 'g');
  if not v_clean_code like 'RC%' and char_length(v_clean_code) = 16 then
    v_clean_code := 'RC' || v_clean_code;
  end if;

  if char_length(v_clean_code) = 18 and v_clean_code like 'RC%' then
    v_raw_code := 'RC-' || substring(v_clean_code from 3 for 4) || '-' ||
                           substring(v_clean_code from 7 for 4) || '-' ||
                           substring(v_clean_code from 11 for 4) || '-' ||
                           substring(v_clean_code from 15 for 4);
  end if;

  v_rc_hash := encode(digest('bday-rc-v1::' || v_raw_code, 'sha256'), 'hex');

  select cs.campaign_id
    into v_campaign_id
  from public.campaign_secrets cs
  where cs.recovery_code_hash = v_rc_hash;

  if v_campaign_id is null then
    return jsonb_build_object(
      'ok', false,
      'message', '일치하는 펀딩을 찾을 수 없습니다. 복구 코드를 다시 확인해 주세요.'
    );
  end if;

  select id, host_name, event_type, headline, subtitle, created_at
    into v_campaign
  from public.campaigns
  where id = v_campaign_id;

  if not found then
    return jsonb_build_object('ok', false, 'message', '해당 펀딩의 기본 정보를 찾을 수 없습니다.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'campaign_id', v_campaign.id,
    'host_name', v_campaign.host_name,
    'event_type', v_campaign.event_type,
    'headline', v_campaign.headline,
    'subtitle', v_campaign.subtitle,
    'created_at', v_campaign.created_at
  );
end;
$$;

-- 펀딩 주인 로그아웃 (서버 세션 즉시 폐기)
create function public.logout_campaign_owner(
  p_campaign_id text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_session_token is null or trim(p_session_token) = '' then
    return true;
  end if;

  delete from public.campaign_sessions
  where token_hash = encode(digest('bday-session-v1::' || trim(p_session_token), 'sha256'), 'hex')
    and campaign_id = trim(coalesce(p_campaign_id, ''));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3-C. [공개 RPC] 펀딩 주인 전용 관리 (서버에서 세션 + campaign_id 소속 검증)
-- ---------------------------------------------------------------------------

create function public.owner_set_intro_photo(
  p_campaign_id text,
  p_session_token text,
  p_object_path text,
  p_intro_image_fit text default 'cover'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_path text := trim(coalesce(p_object_path, ''));
  v_fit text := case when trim(coalesce(p_intro_image_fit, '')) = 'contain' then 'contain' else 'cover' end;
  v_old_path text;
  v_current_pending text;
  v_object_exists boolean;
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    return jsonb_build_object(
      'ok', false,
      'message', '관리자 세션이 만료되었거나 권한이 없습니다. 다시 관리 비밀번호로 로그인해 주세요.'
    );
  end if;

  if not public.check_rate_limit('set_intro_photo::' || v_cid, public.get_client_fingerprint(), 15, 600) then
    return jsonb_build_object(
      'ok', false,
      'message', '단시간에 너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해 주세요.'
    );
  end if;

  select intro_image_url, pending_delete_image_url
  into v_old_path, v_current_pending
  from public.campaigns
  where id = v_cid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', '존재하지 않는 펀딩입니다.');
  end if;

  if v_path = '' then
    update public.campaigns
    set intro_image_url = '',
        intro_image_fit = 'cover',
        pending_delete_image_url = coalesce(nullif(v_old_path, ''), v_current_pending, ''),
        updated_at = now()
    where id = v_cid;

    return jsonb_build_object(
      'ok', true,
      'intro_image_url', '',
      'intro_image_fit', 'cover',
      'previous_image_url', coalesce(v_old_path, ''),
      'pending_delete_image_url', coalesce(nullif(v_old_path, ''), v_current_pending, '')
    );
  end if;

  if v_path = v_old_path then
    update public.campaigns
    set intro_image_fit = v_fit,
        updated_at = now()
    where id = v_cid;

    return jsonb_build_object(
      'ok', true,
      'intro_image_url', v_path,
      'intro_image_fit', v_fit,
      'previous_image_url', '',
      'pending_delete_image_url', coalesce(v_current_pending, '')
    );
  end if;

  if split_part(v_path, '/', 1) <> 'intros'
     or split_part(v_path, '/', 2) not like (v_cid || '-%')
     or split_part(v_path, '/', 2) !~ '^[a-zA-Z0-9_-]+-[0-9]+-[0-9a-f]{16}\.(webp|jpg|jpeg|png)$'
     or split_part(v_path, '/', 3) <> '' then
    return jsonb_build_object(
      'ok', false,
      'message', '유효하지 않은 인트로 사진 경로입니다. 외부 URL이나 다른 펀딩의 사진은 사용할 수 없습니다.'
    );
  end if;

  select exists (
    select 1
    from storage.objects
    where bucket_id = 'gift-image'
      and name = v_path
  ) into v_object_exists;

  if not coalesce(v_object_exists, false) then
    return jsonb_build_object(
      'ok', false,
      'message', 'Storage에서 업로드된 사진 파일을 찾을 수 없습니다. 기존 사진은 그대로 유지됩니다.'
    );
  end if;

  update public.campaigns
  set intro_image_url = v_path,
      intro_image_fit = v_fit,
      pending_delete_image_url = coalesce(nullif(v_old_path, ''), v_current_pending, ''),
      updated_at = now()
  where id = v_cid;

  return jsonb_build_object(
    'ok', true,
    'intro_image_url', v_path,
    'intro_image_fit', v_fit,
    'previous_image_url', coalesce(v_old_path, ''),
    'pending_delete_image_url', coalesce(nullif(v_old_path, ''), v_current_pending, '')
  );
end;
$$;

create function public.owner_confirm_intro_deleted(
  p_campaign_id text,
  p_session_token text,
  p_deleted_path text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_path text := trim(coalesce(p_deleted_path, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    return jsonb_build_object(
      'ok', false,
      'message', '관리자 세션이 만료되었거나 권한이 없습니다.'
    );
  end if;

  update public.campaigns
  set pending_delete_image_url = '',
      updated_at = now()
  where id = v_cid
    and (pending_delete_image_url = v_path or v_path = '');

  return jsonb_build_object('ok', true);
end;
$$;

create function public.owner_update_campaign(
  p_campaign_id text,
  p_session_token text,
  p_host_name text,
  p_emoji text,
  p_birthday_date text,
  p_headline text,
  p_subtitle text,
  p_bio text,
  p_bank_name text,
  p_bank_account text,
  p_kakao_remit_url text,
  p_toss_remit_url text,
  p_event_type text default 'birthday',
  p_intro_message text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_name text := trim(coalesce(p_host_name, ''));
  v_event_type text := lower(trim(coalesce(p_event_type, 'birthday')));
  v_intro_msg text := trim(coalesce(p_intro_message, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다. 다시 관리 비밀번호로 로그인해 주세요.';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception '주인공 이름은 1~30자로 입력해 주세요.';
  end if;

  if v_event_type not in ('birthday', 'graduation', 'wedding', 'employment', 'admission', 'custom') then
    v_event_type := 'birthday';
  end if;

  update public.campaigns
  set host_name = v_name,
      emoji = coalesce(nullif(trim(coalesce(p_emoji, '')), ''), '🎂'),
      birthday_date = trim(coalesce(p_birthday_date, '')),
      headline = coalesce(nullif(trim(coalesce(p_headline, '')), ''), v_name || '의 선물 펀딩'),
      subtitle = coalesce(nullif(trim(coalesce(p_subtitle, '')), ''), '소중한 마음을 모으는 위시리스트'),
      bio = trim(coalesce(p_bio, '')),
      bank_name = trim(coalesce(p_bank_name, '')),
      bank_account = trim(coalesce(p_bank_account, '')),
      kakao_remit_url = trim(coalesce(p_kakao_remit_url, '')),
      toss_remit_url = trim(coalesce(p_toss_remit_url, '')),
      event_type = v_event_type,
      intro_message = v_intro_msg,
      updated_at = now()
  where id = v_cid;

  return found;
end;
$$;

create function public.owner_save_gift(
  p_campaign_id text,
  p_session_token text,
  p_gift_id text,
  p_category text,
  p_priority integer,
  p_title text,
  p_brand text,
  p_goal_amount integer,
  p_description text,
  p_image_url text,
  p_image_fit text,
  p_product_url text default ''
)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_gid text := trim(coalesce(p_gift_id, ''));
  v_prod_url text := trim(coalesce(p_product_url, ''));
  v_existing_cid text;
  v_gift_count integer;
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다. 다시 관리 비밀번호로 로그인해 주세요.';
  end if;

  if char_length(trim(coalesce(p_title, ''))) < 1 then
    raise exception '선물 이름을 입력해 주세요.';
  end if;

  if p_goal_amount is null or p_goal_amount < 1000 or p_goal_amount > 100000000 then
    raise exception '목표 금액은 1,000원 이상 1억 원 이하로 설정해 주세요.';
  end if;

  if v_gid <> '' then
    select campaign_id into v_existing_cid
    from public.gifts
    where id = v_gid;

    if v_existing_cid is not null and v_existing_cid <> v_cid then
      raise exception '다른 펀딩의 선물은 수정할 수 없습니다.';
    end if;
  end if;

  if v_existing_cid is null then
    select count(*) into v_gift_count
    from public.gifts
    where campaign_id = v_cid;

    if v_gift_count >= 20 then
      raise exception '한 펀딩당 선물은 최대 20개까지 등록할 수 있습니다.';
    end if;

    -- 새 선물 ID는 항상 서버에서 발급
    v_gid := v_cid || '-gift-' || encode(gen_random_bytes(5), 'hex');

    insert into public.gifts (
      id, campaign_id, category, priority, title, brand, goal_amount, description, image_url, image_fit, product_url
    ) values (
      v_gid,
      v_cid,
      coalesce(nullif(trim(coalesce(p_category, '')), ''), 'fashion'),
      least(5, greatest(1, coalesce(p_priority, 1))),
      trim(p_title),
      trim(coalesce(p_brand, '')),
      p_goal_amount,
      trim(coalesce(p_description, '')),
      trim(coalesce(p_image_url, '')),
      case when p_image_fit = 'contain' then 'contain' else 'cover' end,
      v_prod_url
    );
  else
    update public.gifts
    set category = coalesce(nullif(trim(coalesce(p_category, '')), ''), 'fashion'),
        priority = least(5, greatest(1, coalesce(p_priority, 1))),
        title = trim(p_title),
        brand = trim(coalesce(p_brand, '')),
        goal_amount = p_goal_amount,
        description = trim(coalesce(p_description, '')),
        image_url = trim(coalesce(p_image_url, '')),
        image_fit = case when p_image_fit = 'contain' then 'contain' else 'cover' end,
        product_url = v_prod_url
    where id = v_gid
      and campaign_id = v_cid;
  end if;

  return v_gid;
end;
$$;

create function public.owner_delete_gift(
  p_campaign_id text,
  p_session_token text,
  p_gift_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다.';
  end if;

  delete from public.gifts
  where id = trim(coalesce(p_gift_id, ''))
    and campaign_id = v_cid;

  return found;
end;
$$;

create function public.owner_set_contribution_status(
  p_campaign_id text,
  p_session_token text,
  p_contribution_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다.';
  end if;

  if p_status is null or p_status not in ('pending', 'approved') then
    raise exception '유효하지 않은 상태값입니다.';
  end if;

  update public.contributions
  set status = p_status
  where id = trim(coalesce(p_contribution_id, ''))
    and campaign_id = v_cid;

  return found;
end;
$$;

create function public.owner_delete_contribution(
  p_campaign_id text,
  p_session_token text,
  p_contribution_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다.';
  end if;

  delete from public.contributions
  where id = trim(coalesce(p_contribution_id, ''))
    and campaign_id = v_cid;

  return found;
end;
$$;

create function public.owner_reset_contributions(
  p_campaign_id text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
begin
  if not public.verify_campaign_session(v_cid, p_session_token) then
    raise exception '관리자 세션이 만료되었거나 권한이 없습니다.';
  end if;

  delete from public.contributions
  where campaign_id = v_cid;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3-D. [공개 RPC] 친구(방문자) 참여 · 사진 관리 · 응원 하트
-- ---------------------------------------------------------------------------

-- '송금했어요' 참여 등록 (항상 pending 상태로 저장)
--   레이트 리밋 카운터가 롤백되지 않도록 {ok:boolean, contribution_id, message} JSON을 반환합니다.
create function public.create_pending_contribution(
  p_campaign_id text,
  p_gift_id text,
  p_sender_name text,
  p_relation text,
  p_amount integer,
  p_message text,
  p_avatar_url text default '',
  p_theme text default 'warm-cream',
  p_created_at_label text default '',
  p_pin text default '',
  p_honeypot text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_gid text := trim(coalesce(p_gift_id, ''));
  v_sender text := trim(coalesce(p_sender_name, ''));
  v_msg text := trim(coalesce(p_message, ''));
  v_pin text := trim(coalesce(p_pin, ''));
  v_contrib_id text;
begin
  if coalesce(p_honeypot, '') <> '' then
    return jsonb_build_object('ok', false, 'message', '비정상적인 요청이 감지되었습니다.');
  end if;

  if v_sender = '' or char_length(v_sender) > 30 then
    return jsonb_build_object('ok', false, 'message', '보내는 분(입금자) 이름을 1~30자로 입력해 주세요.');
  end if;

  if v_msg = '' or char_length(v_msg) > 300 then
    return jsonb_build_object('ok', false, 'message', '축하 메시지를 1~300자로 입력해 주세요.');
  end if;

  if p_amount is null or p_amount < 1000 or p_amount > 50000000 then
    return jsonb_build_object('ok', false, 'message', '펀딩 금액은 1,000원 이상 5,000만 원 이하로 입력해 주세요.');
  end if;

  if not exists (
    select 1 from public.gifts
    where id = v_gid and campaign_id = v_cid
  ) then
    return jsonb_build_object('ok', false, 'message', '해당 펀딩에 존재하지 않는 선물입니다.');
  end if;

  -- 참여 도배 방지 (동일 클라이언트 펀딩별 1분당 10회)
  if not public.check_rate_limit('create_contrib_ip::' || v_cid, public.get_client_fingerprint(), 10, 60) then
    return jsonb_build_object('ok', false, 'message', '너무 빠른 속도로 참여 요청을 보냈습니다. 잠시 후 다시 시도해 주세요.');
  end if;

  v_contrib_id := 'pledge-' || extract(epoch from now())::bigint::text || '-' || encode(gen_random_bytes(4), 'hex');

  insert into public.contributions (
    id, campaign_id, gift_id, sender_name, relation, amount, message,
    avatar_url, theme, status, cheers, created_at_label
  ) values (
    v_contrib_id,
    v_cid,
    v_gid,
    v_sender,
    coalesce(nullif(trim(coalesce(p_relation, '')), ''), '친구'),
    p_amount,
    v_msg,
    trim(coalesce(p_avatar_url, '')),
    coalesce(nullif(trim(coalesce(p_theme, '')), ''), 'warm-cream'),
    'pending',
    0,
    trim(coalesce(p_created_at_label, ''))
  );

  if char_length(v_pin) >= 4 then
    insert into public.contribution_secrets (contribution_id, pin_hash)
    values (v_contrib_id, crypt(v_pin, gen_salt('bf', 10)))
    on conflict (contribution_id) do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'contribution_id', v_contrib_id
  );
end;
$$;

-- 참여자 본인 프로필 사진 변경·삭제 (참여자 PIN 또는 펀딩 주인 세션)
--   PIN 실패 횟수·잠금·레이트 리밋 카운터가 롤백되지 않도록 {ok:boolean, message} JSON을 반환합니다.
create function public.manage_own_avatar(
  p_campaign_id text,
  p_contribution_id text,
  p_pin text,
  p_new_avatar_url text,
  p_owner_session_token text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cid text := trim(coalesce(p_campaign_id, ''));
  v_pledge_id text := trim(coalesce(p_contribution_id, ''));
  v_secret record;
  v_remaining_mins integer;
begin
  if not exists (
    select 1 from public.contributions
    where id = v_pledge_id and campaign_id = v_cid
  ) then
    return jsonb_build_object('ok', false, 'message', '대상 참여 내역을 찾을 수 없습니다.');
  end if;

  -- 펀딩 주인 세션이 유효한 경우 PIN 없이 즉시 변경 허용
  if public.verify_campaign_session(v_cid, p_owner_session_token) then
    update public.contributions
    set avatar_url = trim(coalesce(p_new_avatar_url, ''))
    where id = v_pledge_id and campaign_id = v_cid;
    return jsonb_build_object('ok', true);
  end if;

  -- 동일 클라이언트의 PIN 무차별 대입 제한 (5분당 12회)
  if not public.check_rate_limit('manage_avatar_ip::' || v_pledge_id, public.get_client_fingerprint(), 12, 300) then
    return jsonb_build_object('ok', false, 'message', '비밀번호 확인 시도가 너무 많습니다. 5분 후 다시 시도해 주세요.');
  end if;

  select contribution_id, pin_hash, failed_attempts, locked_until
    into v_secret
  from public.contribution_secrets
  where contribution_id = v_pledge_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', '이 참여 내역에는 사진 관리 비밀번호가 설정되어 있지 않습니다.');
  end if;

  if v_secret.locked_until is not null and v_secret.locked_until > now() then
    v_remaining_mins := greatest(1, ceil(extract(epoch from (v_secret.locked_until - now())) / 60.0)::integer);
    return jsonb_build_object(
      'ok', false,
      'message', format('비밀번호 5회 연속 오류로 사진 변경이 잠겼습니다. 약 %s분 후 다시 시도해 주세요.', v_remaining_mins)
    );
  end if;

  if v_secret.pin_hash <> crypt(trim(coalesce(p_pin, '')), v_secret.pin_hash) then
    if v_secret.failed_attempts + 1 >= 5 then
      update public.contribution_secrets
      set failed_attempts = 0,
          locked_until = now() + interval '15 minutes'
      where contribution_id = v_pledge_id;
      return jsonb_build_object('ok', false, 'message', '비밀번호를 5회 연속 틀려 15분간 사진 변경이 잠겼습니다.');
    else
      update public.contribution_secrets
      set failed_attempts = failed_attempts + 1,
          locked_until = null
      where contribution_id = v_pledge_id;
      return jsonb_build_object(
        'ok', false,
        'message', format('비밀번호가 일치하지 않습니다. (남은 시도 횟수: %s회)', 5 - (v_secret.failed_attempts + 1))
      );
    end if;
  end if;

  update public.contribution_secrets
  set failed_attempts = 0,
      locked_until = null
  where contribution_id = v_pledge_id;

  update public.contributions
  set avatar_url = trim(coalesce(p_new_avatar_url, ''))
  where id = v_pledge_id and campaign_id = v_cid;

  return jsonb_build_object('ok', true);
end;
$$;

-- 응원 하트(❤️) +1 / -1 (클라이언트별·내역별 레이트 리밋 적용으로 어뷰징 방지)
create function public.increment_contribution_cheer(
  p_contribution_id text,
  p_delta integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id text := trim(coalesce(p_contribution_id, ''));
  v_fp text;
  v_current_cheers integer;
  v_new_cheers integer;
begin
  if v_id = '' then
    return 0;
  end if;

  select cheers into v_current_cheers
  from public.contributions
  where id = v_id;

  if not found then
    return 0;
  end if;

  v_fp := public.get_client_fingerprint();

  -- 동일 클라이언트당 특정 참여 내역 1분 6회, 전체 1분 30회 제한 (초과 시 예외 없이 현재 값 반환하여 카운터 커밋)
  if not public.check_rate_limit('cheer_item_ip::' || v_id, v_fp, 6, 60) then
    return coalesce(v_current_cheers, 0);
  end if;
  if not public.check_rate_limit('cheer_global_ip', v_fp, 30, 60) then
    return coalesce(v_current_cheers, 0);
  end if;

  update public.contributions
  set cheers = least(99999, greatest(0, cheers + case when p_delta < 0 then -1 else 1 end))
  where id = v_id
  returning cheers into v_new_cheers;

  return coalesce(v_new_cheers, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3-D. 응원 메시지 대댓글(Reply) 관련 함수
-- ---------------------------------------------------------------------------

-- 대댓글 작성 RPC 함수
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

-- 펀딩 주인(관리자)의 답글 삭제 RPC 함수
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

-- 일반 방문자의 답글 신고 접수 RPC 함수 (스팸/부적절한 내용)
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

-- ============================================================================
-- 4. 권한 설정
--    Supabase는 public 스키마의 새 테이블/함수에 기본 권한을 자동 부여하므로,
--    먼저 모두 회수한 뒤 최소 권한만 명시적으로 부여합니다.
-- ============================================================================
grant usage on schema public to anon, authenticated;

-- (1) 테이블: 공개 4개는 SELECT만 허용, 비공개 4개는 접근 완전 차단
revoke all on table
  public.campaigns, public.gifts, public.contributions, public.contribution_replies,
  public.campaign_secrets, public.campaign_sessions,
  public.contribution_secrets, public.rate_limit_logs
from anon, authenticated;

grant select on table public.campaigns, public.gifts, public.contributions, public.contribution_replies to anon, authenticated;

-- (2) 함수: 모든 함수의 PUBLIC/anon/authenticated 실행 권한 회수
revoke all on function public.get_client_fingerprint() from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.verify_campaign_session(text, text) from public, anon, authenticated;
revoke all on function public.owner_check_session(text, text) from public, anon, authenticated;
revoke all on function public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.login_campaign_owner(text, text) from public, anon, authenticated;
revoke all on function public.lookup_campaign_by_recovery_code(text) from public, anon, authenticated;
revoke all on function public.logout_campaign_owner(text, text) from public, anon, authenticated;
revoke all on function public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_delete_gift(text, text, text) from public, anon, authenticated;
revoke all on function public.owner_set_contribution_status(text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_delete_contribution(text, text, text) from public, anon, authenticated;
revoke all on function public.owner_reset_contributions(text, text) from public, anon, authenticated;
revoke all on function public.create_pending_contribution(text, text, text, text, integer, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.create_contribution_reply(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_delete_reply(text, text, text) from public, anon, authenticated;
revoke all on function public.report_contribution_reply(text, text) from public, anon, authenticated;
revoke all on function public.manage_own_avatar(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.increment_contribution_cheer(text, integer) from public, anon, authenticated;
revoke all on function public.owner_set_intro_photo(text, text, text, text) from public, anon, authenticated;
revoke all on function public.owner_confirm_intro_deleted(text, text, text) from public, anon, authenticated;

-- (3) 공개 RPC에만 실행 권한 부여
--     ※ get_client_fingerprint / check_rate_limit / verify_campaign_session 은
--       내부 전용이므로 anon·authenticated 에 실행 권한을 부여하지 않습니다.
grant execute on function public.owner_check_session(text, text) to anon, authenticated;
grant execute on function public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.login_campaign_owner(text, text) to anon, authenticated;
grant execute on function public.lookup_campaign_by_recovery_code(text) to anon, authenticated;
grant execute on function public.logout_campaign_owner(text, text) to anon, authenticated;
grant execute on function public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text, text) to anon, authenticated;
grant execute on function public.owner_delete_gift(text, text, text) to anon, authenticated;
grant execute on function public.owner_set_contribution_status(text, text, text, text) to anon, authenticated;
grant execute on function public.owner_delete_contribution(text, text, text) to anon, authenticated;
grant execute on function public.owner_reset_contributions(text, text) to anon, authenticated;
grant execute on function public.create_pending_contribution(text, text, text, text, integer, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.create_contribution_reply(text, text, text, text, text) to anon, authenticated;
grant execute on function public.owner_delete_reply(text, text, text) to anon, authenticated;
grant execute on function public.report_contribution_reply(text, text) to anon, authenticated;
grant execute on function public.manage_own_avatar(text, text, text, text, text) to anon, authenticated;
grant execute on function public.increment_contribution_cheer(text, integer) to anon, authenticated;
grant execute on function public.owner_set_intro_photo(text, text, text, text) to anon, authenticated;
grant execute on function public.owner_confirm_intro_deleted(text, text, text) to anon, authenticated;

-- ============================================================================
-- 5. Storage ('gift-image' 공개 버킷)
--    - 허용 MIME 형식: image/jpeg, image/png, image/webp
--    - 최대 파일 크기: 5MB (5,242,880 bytes)
--    - avatars/ 및 gifts/ 1단계 하위 경로의 이미지 확장자 파일만 INSERT 허용
--    - UPDATE / DELETE 정책 미부여로 기존 파일 덮어쓰기 및 무단 삭제 차단
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gift-image',
  'gift-image',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "gift_image_public_select" on storage.objects;
create policy "gift_image_public_select"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'gift-image');

drop policy if exists "gift_image_safe_insert" on storage.objects;
create policy "gift_image_safe_insert"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'gift-image'
    and (storage.foldername(name))[1] in ('avatars', 'gifts', 'intros')
    and array_length(storage.foldername(name), 1) = 1
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
    and char_length(name) between 12 and 160
  );

-- intros/ 폴더 파일 삭제 정책:
-- 오직 펀딩 주인이 인증을 거쳐 pending_delete_image_url에 지정한 이전 사진 파일만 Storage 삭제 API를 통해 삭제 허용
-- (임의의 미사용 파일이나 다른 펀딩 사진, avatars/gifts 파일은 무단 삭제 절대 불가)
drop policy if exists "gift_image_safe_intro_delete" on storage.objects;
create policy "gift_image_safe_intro_delete"
  on storage.objects for delete
  to anon, authenticated
  using (
    bucket_id = 'gift-image'
    and (storage.foldername(name))[1] = 'intros'
    and array_length(storage.foldername(name), 1) = 1
    and exists (
      select 1
      from public.campaigns c
      where c.pending_delete_image_url = name
        and split_part(name, '/', 2) like (c.id || '-%')
    )
  );

-- ============================================================================
-- 6. Realtime 설정 (테이블이 1단계에서 생성된 뒤에 실행됨)
-- ============================================================================
do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach v_table in array array['campaigns', 'gifts', 'contributions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

commit;

-- ============================================================================
-- (선택) 실행 완료 후 검증용 조회 쿼리
-- select tablename from pg_tables where schemaname = 'public' order by 1;
-- select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1;
-- ============================================================================
