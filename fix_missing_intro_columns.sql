-- ============================================================================
-- personal_funding — 누락된 인트로 사진 컬럼 2개 즉시 추가 쿼리
--
-- 실행 대상 : personal_funding Supabase 프로젝트 (swhbilnenhsabgadpttf)
--             ※ 기존 조소현 운영 프로젝트(bokjhtujnatxjvkpejks)에서는 절대 실행하지 마세요.
-- 실행 위치 : Supabase Dashboard -> SQL Editor -> [+ New query] -> 붙여넣고 [Run]
-- 안전성   : 기존 펀딩 데이터(박서현 등)는 100% 보존되며 기본값('', 'cover')이 자동 적용됩니다.
-- ============================================================================

-- 1. 누락된 intro_image_url, intro_image_fit 컬럼 추가
alter table public.campaigns
  add column if not exists intro_image_url text not null default '',
  add column if not exists intro_image_fit text not null default 'cover';

-- 2. 액자 맞춤 방식 제약 조건 추가 ('cover' 또는 'contain')
alter table public.campaigns
  drop constraint if exists campaigns_intro_image_fit_check;

alter table public.campaigns
  add constraint campaigns_intro_image_fit_check
  check (intro_image_fit in ('cover', 'contain'));

-- 3. 인트로 사진 경로 무결성 제약 조건 추가 (해당 캠페인 전용 Storage 경로만 허용)
alter table public.campaigns
  drop constraint if exists campaigns_intro_image_path_check;

alter table public.campaigns
  add constraint campaigns_intro_image_path_check
  check (
    intro_image_url = ''
    or (
      split_part(intro_image_url, '/', 1) = 'intros'
      and split_part(intro_image_url, '/', 2) like (id || '-%')
      and split_part(intro_image_url, '/', 2) ~ '^[a-zA-Z0-9_-]+-[0-9]+-[0-9a-f]{16}\.(webp|jpg|jpeg|png)$'
      and split_part(intro_image_url, '/', 3) = ''
    )
  );
