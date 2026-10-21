-- ============================================================================
-- personal_funding — 인트로 액자 사진(1장) 기능 추가 마이그레이션 SQL (소유자 전용 삭제 보호 최종본)
--
-- 실행 대상 : personal_funding Supabase 프로젝트 (swhbilnenhsabgadpttf)
--             ※ 기존 조소현 운영 프로젝트(bokjhtujnatxjvkpejks)에서는 절대 실행하지 마세요.
-- 실행 방법 : Supabase Dashboard -> SQL Editor -> New query -> 전체 복사/붙여넣기 -> [Run]
-- 안전성   : 1) 기존 테이블과 기존 펀딩 데이터를 전혀 삭제하거나 변경하지 않습니다.
--            2) 복잡한 업로드 티켓 테이블 없이 campaigns 컬럼과 전용 RPC만 추가합니다.
--            3) Storage DELETE 정책은 펀딩 주인이 인증 후 삭제 요청한 파일(pending_delete_image_url)만 삭제를 허용하여
--               익명 사용자의 무단 파일 삭제나 타 펀딩 사진 삭제를 완벽히 차단합니다.
--            4) 단일 트랜잭션(begin ~ commit)으로 실행되며 재실행이 가능합니다.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. public.campaigns 테이블에 인트로 사진 경로, 맞춤 방식, 삭제 대기 파일 컬럼 추가
--    - intro_image_url          : 현재 활성화된 인트로 사진 경로 ('intros/{id}-...' 또는 '')
--    - intro_image_fit          : 액자 맞춤 방식 ('cover' 또는 'contain')
--    - pending_delete_image_url : 펀딩 주인이 교체/삭제하여 Storage에서 제거 대기 중인 이전 사진 경로
-- ----------------------------------------------------------------------------
alter table public.campaigns
  add column if not exists intro_image_url text not null default '',
  add column if not exists intro_image_fit text not null default 'cover',
  add column if not exists pending_delete_image_url text not null default '';

alter table public.campaigns
  drop constraint if exists campaigns_intro_image_fit_check;

alter table public.campaigns
  add constraint campaigns_intro_image_fit_check
  check (intro_image_fit in ('cover', 'contain'));

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

alter table public.campaigns
  drop constraint if exists campaigns_pending_delete_path_check;

alter table public.campaigns
  add constraint campaigns_pending_delete_path_check
  check (
    pending_delete_image_url = ''
    or (
      split_part(pending_delete_image_url, '/', 1) = 'intros'
      and split_part(pending_delete_image_url, '/', 2) like (id || '-%')
      and split_part(pending_delete_image_url, '/', 2) ~ '^[a-zA-Z0-9_-]+-[0-9]+-[0-9a-f]{16}\.(webp|jpg|jpeg|png)$'
      and split_part(pending_delete_image_url, '/', 3) = ''
    )
  );

-- ----------------------------------------------------------------------------
-- 2. [공개 RPC] 펀딩 주인 전용 인트로 사진 연결 · 변경 · 삭제 함수
--    - 반드시 verify_campaign_session()으로 펀딩 주인 세션을 검증합니다.
--    - 사진 교체/삭제 시 이전 파일 경로를 pending_delete_image_url에 기록하여
--      오직 해당 펀딩의 주인만 Storage 삭제 API를 통해 실제 파일을 안전하게 지울 수 있도록 허용합니다.
-- ----------------------------------------------------------------------------
drop function if exists public.owner_set_intro_photo(text, text, text, text);

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
  -- 1) 펀딩 주인 세션 검증
  if not public.verify_campaign_session(v_cid, p_session_token) then
    return jsonb_build_object(
      'ok', false,
      'message', '관리자 세션이 만료되었거나 권한이 없습니다. 다시 관리 비밀번호로 로그인해 주세요.'
    );
  end if;

  -- 2) 무차별 호출 방지 레이트 리밋 (동일 캠페인/클라이언트 10분당 15회)
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

  -- 3) 사진 삭제(기본 이미지로 복원) 요청인 경우
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

  -- 4) 사진 교체 없이 표시 방식(fit)만 변경하는 경우
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

  -- 5) 새 사진 경로 검증: 외부 URL 차단 및 반드시 해당 캠페인('intros/{v_cid}-{timestamp}-{random16}.{ext}') 경로인지 확인
  if split_part(v_path, '/', 1) <> 'intros'
     or split_part(v_path, '/', 2) not like (v_cid || '-%')
     or split_part(v_path, '/', 2) !~ '^[a-zA-Z0-9_-]+-[0-9]+-[0-9a-f]{16}\.(webp|jpg|jpeg|png)$'
     or split_part(v_path, '/', 3) <> '' then
    return jsonb_build_object(
      'ok', false,
      'message', '유효하지 않은 인트로 사진 경로입니다. 외부 URL이나 다른 펀딩의 사진은 사용할 수 없습니다.'
    );
  end if;

  -- 6) Storage에 새 파일이 실제로 업로드되어 존재하는지 확인 (실패 시 기존 사진 유지)
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

  -- 7) 새 사진 경로를 캠페인에 저장하고, 이전 사진 경로를 삭제 대기(pending_delete_image_url)로 지정
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

revoke all on function public.owner_set_intro_photo(text, text, text, text) from public, anon, authenticated;
grant execute on function public.owner_set_intro_photo(text, text, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. [공개 RPC] 펀딩 주인 전용 Storage 삭제 완료 확인 함수
--    - Storage API(.remove) 호출이 성공했을 때 pending_delete_image_url을 초기화합니다.
-- ----------------------------------------------------------------------------
drop function if exists public.owner_confirm_intro_deleted(text, text, text);

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

revoke all on function public.owner_confirm_intro_deleted(text, text, text) from public, anon, authenticated;
grant execute on function public.owner_confirm_intro_deleted(text, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Storage 버킷 제한(JPG/PNG/WebP, 최대 5MB) 및 RLS 정책 갱신
--    - INSERT: avatars/, gifts/, intros/ 1단계 폴더의 이미지 파일만 허용 (덮어쓰기 불가)
--    - DELETE: 오직 펀딩 주인이 인증을 통과하여 pending_delete_image_url에 지정한
--              해당 펀딩의 이전 사진 파일만 Storage 삭제 API를 통해 삭제 허용
--              -> 임의의 미사용 파일이나 다른 펀딩 사진, avatars/gifts 파일은 무단 삭제 절대 불가
-- ----------------------------------------------------------------------------
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

commit;
