-- ============================================================================
-- personal_funding: 이벤트 종류(생일, 졸업, 결혼, 입사, 입학, 직접 설정) 및 인트로 문구 마이그레이션
-- 
-- 적용 내용:
-- 1. public.campaigns 테이블에 event_type, intro_message 컬럼 추가
-- 2. 기존 펀딩 데이터는 기본값('birthday', '')으로 안전하게 보존
-- 3. create_funding_campaign RPC 업데이트 (p_event_type, p_intro_message 지원)
-- 4. owner_update_campaign RPC 업데이트 (p_event_type, p_intro_message 수정 지원)
-- ============================================================================

begin;

-- (1) campaigns 테이블에 이벤트 종류 및 인트로 문구 컬럼 추가
alter table public.campaigns
  add column if not exists event_type text not null default 'birthday',
  add column if not exists intro_message text not null default '';

-- 기존 레코드 기본값 보장
update public.campaigns
set event_type = 'birthday'
where event_type is null or event_type = '';

-- (2) 구버전(12개 인자) 함수 삭제 (PostgreSQL 오버로딩 중복 충돌 방지)
-- 14개 인자로 확장 시 기존 12개 인자 함수가 남아있으면 "Could not choose the best candidate function" 오류가 발생합니다.
drop function if exists public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text);

-- (3) create_funding_campaign 함수 업데이트 (14개 인자)
create or replace function public.create_funding_campaign(
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
begin
  if coalesce(p_honeypot, '') <> '' then
    return jsonb_build_object('ok', false, 'message', '비정상적인 요청이 감지되었습니다.');
  end if;

  if char_length(v_clean_name) < 1 or char_length(v_clean_name) > 30 then
    return jsonb_build_object('ok', false, 'message', '주인공 이름은 1자 이상 30자 이하로 입력해 주세요.');
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

  insert into public.campaign_secrets (campaign_id, password_hash)
  values (v_campaign_id, crypt(v_clean_pw, gen_salt('bf', 10)));

  insert into public.gifts (id, campaign_id, category, priority, title, brand, goal_amount, description, image_url, image_fit)
  values
    (v_campaign_id || '-gift-1', v_campaign_id, 'fashion', 1,
     v_clean_name || '의 1순위 위시 선물', '관리자 모드에서 사진·이름·금액 수정 가능', 250000,
     '[✏️ 사진·내용 수정] 버튼을 눌러 받고 싶은 실제 선물 사진과 목표 금액을 등록해 보세요.', '', 'cover'),
    (v_campaign_id || '-gift-2', v_campaign_id, 'fragrance', 2,
     v_clean_name || '의 2순위 위시 선물', '위시 아이템', 150000,
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
    'session_token', v_raw_token
  );
end;
$$;

-- (4) owner_update_campaign 함수 업데이트
create or replace function public.owner_update_campaign(
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

-- (5) 실행 권한 재부여
grant execute on function public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.owner_update_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;

commit;
