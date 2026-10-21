-- ============================================================================
-- personal_funding: 위시리스트 선물별 쇼핑몰 상품 URL 기능 마이그레이션
--
-- 적용 내용:
-- 1. public.gifts 테이블에 product_url 컬럼 추가 (기본값 '')
-- 2. 기존 구버전(11개 인자) owner_save_gift 함수 삭제 (오버로딩 충돌 방지)
-- 3. owner_save_gift RPC 업데이트 (p_product_url text default '' 매개변수 추가)
-- 4. 실행 권한 부여
-- ============================================================================

begin;

-- (1) gifts 테이블에 product_url 컬럼 추가
alter table public.gifts
  add column if not exists product_url text not null default '';

-- (2) 구버전(11개 인자) owner_save_gift 함수 삭제 (PostgreSQL 함수 후보 충돌 방지)
drop function if exists public.owner_save_gift(
  text, text, text, text, integer, text, text, integer, text, text, text
);

-- (3) owner_save_gift 함수 업데이트 (12개 인자)
create or replace function public.owner_save_gift(
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

-- (4) 실행 권한 재부여
grant execute on function public.owner_save_gift(text, text, text, text, integer, text, text, integer, text, text, text, text) to anon, authenticated;

commit;
