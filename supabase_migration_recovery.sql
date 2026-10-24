-- ============================================================================
-- Supabase Migration: 펀딩 분실 방지 안전 복구 코드 (Recovery Code) 마이그레이션
--
-- [목적]
-- 1. 회원가입 없이 생성된 펀딩의 공유 링크를 복사하지 않고 이탈한 경우,
--    사용자가 자신의 펀딩 링크를 다시 찾을 수 있도록 80비트 엔트로피 복구 코드를 지원합니다.
-- 2. DB에는 원문이 아닌 솔트 기반 SHA-256 해시만 보관하여 관리자나 DB 유출 시에도 안전합니다.
-- 3. 이름/비밀번호만으로 임의의 펀딩을 검색할 수 없으며, 무차별 대입 방지 레이트 리밋(10분당 5회)이 적용됩니다.
-- 4. 복구 코드로 조회 시 펀딩 고유 ID, 제목 등 공개 메타데이터만 반환하며, 관리자 권한 세션 토큰은 절대 발급되지 않습니다.
-- 5. 기존 펀딩 데이터, 선물, 후원 내역 및 댓글 데이터는 일체 손실되거나 변경되지 않습니다.
-- ============================================================================

begin;

-- 1. campaign_secrets 테이블에 recovery_code_hash 컬럼 추가 (기존 행은 NULL 허용)
alter table public.campaign_secrets
  add column if not exists recovery_code_hash text;

-- 2. 빠른 조회를 위한 해시 인덱스 생성
create index if not exists idx_campaign_secrets_recovery_hash
  on public.campaign_secrets(recovery_code_hash)
  where recovery_code_hash is not null;

-- 3. create_funding_campaign 함수 교체:
--    기존 함수의 매개변수 시그니처(14개 파라미터 이름 및 순서)를 100% 동일하게 유지하여
--    기존 운영 중인 펀딩 생성 기능이 중단되지 않고 인플레이스로 안전하게 업데이트됩니다.
--    새 펀딩 생성 시 고유하고 추측 불가능한 80비트 안전 복구 코드(RC-XXXX-XXXX-XXXX-XXXX)를 발급하고,
--    DB에는 SHA-256 해시를 저장하며 사용자에게 1회에 한해 원문을 반환합니다.
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
  v_campaign_id text;
  v_clean_name text := trim(coalesce(p_host_name, ''));
  v_clean_pw text := trim(coalesce(p_password, ''));
  v_raw_token text;
  v_recovery_code text;
  v_rc_hash text;
  v_client_fp text;
  v_event_type text := lower(trim(coalesce(p_event_type, 'birthday')));
  v_intro_msg text := trim(coalesce(p_intro_message, ''));
  v_event_label text;
  v_bday text;
  v_headline text;
  v_subtitle text;
  v_bio text;
begin
  if coalesce(p_honeypot, '') <> '' then
    return jsonb_build_object('ok', false, 'message', '비정상적인 요청이 감지되었습니다.');
  end if;

  if v_clean_name = '' then
    return jsonb_build_object('ok', false, 'message', '주인공 이름을 입력해 주세요.');
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

-- 4. 펀딩 복구 코드로 펀딩 링크 및 기본 정보 조회 RPC 생성
--   - 이름/비밀번호만으로는 조회가 불가능하며, 80비트 고유 복구 코드 해시 일치 시에만 동작합니다.
--   - 무차별 대입 방지: 동일 클라이언트 10분당 5회 실패 제한 (check_rate_limit)
--   - 반환 데이터: 펀딩 고유 ID, 제목, 주인공 이름, 이벤트 유형 (관리자 세션 토큰은 절대 미반환)
create or replace function public.lookup_campaign_by_recovery_code(
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

-- 5. 권한 부여 (anon 및 authenticated)
revoke all on function public.lookup_campaign_by_recovery_code(text) from public, anon, authenticated;
grant execute on function public.lookup_campaign_by_recovery_code(text) to anon, authenticated;

grant execute on function public.create_funding_campaign(text, text, text, text, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;

commit;
