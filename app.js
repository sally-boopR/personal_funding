/**
 * personal_funding — 다중 사용자 맞춤 선물 위시리스트 & 크라우드펀딩 웹 앱
 * - 공식 서비스명: personal_funding
 * - 회원가입/이메일 인증 없이 [이름 + 관리 비밀번호(8자 이상)]만으로 고유 펀딩 생성 및 공유 URL(?f=ID) 자동 발급
 * - 각 펀딩의 선물, 참여 내역, 관리자 권한을 campaign_id 기준으로 완전 분리
 * - 비밀번호는 Supabase 서버(pgcrypto bcrypt)에서 해싱 및 검증하며 브라우저에 비밀번호/비밀키 저장 안 함
 * - 비밀번호 복구/찾기/초기화 기능 없음 (펀딩 생성 시 보안 안내 및 보관 주의 문구 명시 및 확인 필수)
 * - 모든 관리자 쓰기 작업은 서버 측 SECURITY DEFINER RPC에서 세션 토큰 검증을 강제
 * - 무차별 비밀번호 대입(5회 연속 실패 시 15분 잠금, 롤백 방지) 및 대량 펀딩 생성 레이트 리밋 적용
 */

(function () {
  'use strict';

  // =========================================================================
  // 0. SUPABASE PUBLIC CLIENT CONFIGURATION (새 개발용 Supabase 프로젝트 설정)
  // ★ 기존 조소현 운영 DB와 완전히 분리되었습니다.
  //   새 개발용 Supabase Dashboard -> Project Settings -> API 의 값을 아래에 입력하거나
  //   웹 화면 상단 [DB 연결 설정] 모달에서 입력할 수 있습니다.
  // ※ 주의: 절대 Secret key (sb_secret_...) 나 service_role 키를 넣지 마세요!
  // =========================================================================
  const SUPABASE_PROJECT_URL = 'https://swhbilnenhsabgadpttf.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_t1AyCelf0yw-XKPMwdIl0Q_Z36PR9Cc';

  const DEFAULT_SUPABASE_CONFIG = {
    url: SUPABASE_PROJECT_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    anonKey: SUPABASE_PUBLISHABLE_KEY,
    bucket: 'gift-image'
  };

  const LOCAL_MULTI_DB_KEY = 'bday_multi_platform_local_db_v1';
  const SUPABASE_CONN_STORAGE_KEY = 'bday_multi_supabase_conn_v1';
  const CHEERED_IDS_STORAGE_KEY = 'bday_multi_cheered_ids_v1';
  const OWNER_SESSION_PREFIX = 'bday_multi_owner_token_v1_';
  const MY_CREATED_FUNDINGS_STORAGE_KEY = 'bday_my_created_fundings_v1';
  const DEFAULT_BUCKET_NAME = 'gift-image';
  const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024; // 5MB file size limit (matches storage.buckets limit)

  // Default Indie Pink Circular Profile Icon SVG
  const DEFAULT_AVATAR_SVG = `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="32" cy="32" r="32" fill="#F8EDF0"/>
      <circle cx="32" cy="24" r="10.5" fill="#C98691"/>
      <path d="M13 55C13 44.5066 21.5066 36 32 36C42.4934 36 51 44.5066 51 55" fill="#C98691"/>
    </svg>
  `;

  // Indie Pink & Cream White SVG Illustrations per Gift Category
  const CATEGORY_SVGS = {
    audio: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <path d="M26 54V48C26 34.7452 36.7452 24 50 24C63.2548 24 74 34.7452 74 48V54" stroke="#493B3E" stroke-width="4" stroke-linecap="round"/>
        <rect x="20" y="50" width="14" height="24" rx="7" fill="#C98691" stroke="#493B3E" stroke-width="3.2"/>
        <rect x="66" y="50" width="14" height="24" rx="7" fill="#C98691" stroke="#493B3E" stroke-width="3.2"/>
        <path d="M43 44C45.5 41 54.5 41 57 44" stroke="#A96575" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `,
    coffee: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <path d="M28 42H64V60C64 69.9411 55.9411 78 46 78C36.0589 78 28 69.9411 28 60V42Z" fill="#E8C5CC" stroke="#493B3E" stroke-width="3.2"/>
        <path d="M64 46H70C74.4183 46 78 49.5817 78 54C78 58.4183 74.4183 62 70 62H64" stroke="#493B3E" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M39 26C39 29 42 31 42 34" stroke="#A96575" stroke-width="3" stroke-linecap="round"/>
        <path d="M51 24C51 28 54 30 54 34" stroke="#A96575" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `,
    camera: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <rect x="22" y="34" width="56" height="40" rx="8" fill="#FFF9F7" stroke="#493B3E" stroke-width="3.2"/>
        <path d="M37 34L41 26H59L63 34" fill="#C98691" stroke="#493B3E" stroke-width="3.2" stroke-linejoin="round"/>
        <circle cx="50" cy="54" r="12" fill="#E8C5CC" stroke="#493B3E" stroke-width="3.2"/>
        <circle cx="67" cy="43" r="3" fill="#A96575"/>
      </svg>
    `,
    fragrance: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <rect x="42" y="22" width="16" height="9" rx="2" fill="#E8C5CC" stroke="#493B3E" stroke-width="2.8"/>
        <rect x="46" y="31" width="8" height="6" fill="#493B3E"/>
        <rect x="31" y="37" width="38" height="42" rx="10" fill="#FFF9F7" stroke="#493B3E" stroke-width="3.2"/>
        <rect x="39" y="49" width="22" height="18" rx="3" fill="#C98691"/>
      </svg>
    `,
    fashion: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <path d="M38 38V32C38 25.3726 43.3726 20 50 20C56.6274 20 62 25.3726 62 32V38" stroke="#493B3E" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M26 38H74L78 76H22L26 38Z" fill="#C98691" stroke="#493B3E" stroke-width="3.2" stroke-linejoin="round"/>
        <circle cx="40" cy="46" r="2.5" fill="#FFF9F7"/>
        <circle cx="60" cy="46" r="2.5" fill="#FFF9F7"/>
      </svg>
    `,
    travel: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <rect x="30" y="32" width="40" height="46" rx="8" fill="#E8C5CC" stroke="#493B3E" stroke-width="3.2"/>
        <path d="M42 32V23C42 21.3431 43.3431 20 45 20H55C56.6569 20 58 21.3431 58 23V32" stroke="#493B3E" stroke-width="3.2"/>
        <line x1="30" y1="46" x2="70" y2="46" stroke="#FFF9F7" stroke-width="3"/>
        <line x1="30" y1="64" x2="70" y2="64" stroke="#FFF9F7" stroke-width="3"/>
      </svg>
    `,
    cake: `
      <svg class="gift-visual-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="42" fill="#FFFFFF" fill-opacity="0.75"/>
        <rect x="24" y="50" width="52" height="26" rx="6" fill="#FFF9F7" stroke="#493B3E" stroke-width="3.2"/>
        <path d="M24 58C30 63 36 53 42 58C48 63 54 53 60 58C66 63 71 54 76 58" stroke="#C98691" stroke-width="3.2" stroke-linecap="round"/>
        <rect x="47" y="32" width="6" height="18" fill="#E8C5CC" stroke="#493B3E" stroke-width="2.5"/>
        <path d="M50 20C53 24 54 28 50 30C46 28 47 24 50 20Z" fill="#A96575"/>
      </svg>
    `
  };

  const CATEGORY_EMOJI = {
    audio: '🎧',
    coffee: '☕',
    camera: '📷',
    fragrance: '🕯️',
    fashion: '🧣',
    travel: '✈️',
    cake: '🎂'
  };

  // Helper: Get today's YYYY-MM-DD string
  function getTodayDateString() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Helper: Check if last Korean character has batchim (종성)
  function hasFinalConsonant(str) {
    const s = String(str || '').trim();
    if (!s) return false;
    const code = s.charCodeAt(s.length - 1);
    if (code < 0xac00 || code > 0xd7a3) return false;
    return (code - 0xac00) % 28 !== 0;
  }

  // e.g. "조소현" -> "소현아", "김민지" -> "민지야"
  function formatVocativeName(fullName) {
    const clean = String(fullName || '친구').trim();
    const givenName = clean.length === 3 ? clean.slice(1) : clean;
    const particle = hasFinalConsonant(givenName) ? '아' : '야';
    return `${givenName}${particle}`;
  }

  const EVENT_TYPE_CONFIG = {
    birthday: {
      key: 'birthday',
      label: '생일',
      emoji: '🎂',
      enTitle: 'Happy Birthday!',
      introPhrase: '생일을 축하합니다!',
      ornament: '♡',
      subCaption: '소중한 마음을 담은 생일 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 생일 선물 펀딩`,
      defaultSubtitle: '소중한 마음을 모으는 생일 위시리스트',
      pledgeTitle: (name) => `${name}님에게 생일 선물 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 생일 축하 인사를 남겨주세요!`
    },
    graduation: {
      key: 'graduation',
      label: '졸업',
      emoji: '🎓',
      enTitle: 'Happy Graduation!',
      introPhrase: '졸업을 축하합니다!',
      ornament: '🎓',
      subCaption: '새로운 출발을 응원하는 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 졸업 축하 펀딩`,
      defaultSubtitle: '새로운 시작을 응원하는 졸업 선물 위시리스트',
      pledgeTitle: (name) => `${name}님에게 졸업 축하 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 졸업 축하와 응원 메시지를 남겨주세요!`
    },
    wedding: {
      key: 'wedding',
      label: '결혼',
      emoji: '💍',
      enTitle: 'Happy Wedding!',
      introPhrase: '결혼을 축하합니다!',
      ornament: '💍',
      subCaption: '축복하는 마음을 담은 결혼 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 결혼 축하 펀딩`,
      defaultSubtitle: '새로운 시작을 축복하는 결혼 선물 위시리스트',
      pledgeTitle: (name) => `${name}님에게 결혼 축하 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 결혼 축하 메시지를 남겨주세요!`
    },
    employment: {
      key: 'employment',
      label: '입사',
      emoji: '💼',
      enTitle: 'Congratulations!',
      introPhrase: '입사를 축하합니다!',
      ornament: '🎉',
      subCaption: '새로운 도약을 응원하는 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 입사 축하 펀딩`,
      defaultSubtitle: '새로운 도전을 응원하는 입사 축하 위시리스트',
      pledgeTitle: (name) => `${name}님에게 입사 축하 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 입사 축하와 응원 메시지를 남겨주세요!`
    },
    admission: {
      key: 'admission',
      label: '입학',
      emoji: '🎒',
      enTitle: 'Congratulations!',
      introPhrase: '입학을 축하합니다!',
      ornament: '🎒',
      subCaption: '설레는 시작을 응원하는 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 입학 축하 펀딩`,
      defaultSubtitle: '설레는 새 학기 시작을 응원하는 선물 위시리스트',
      pledgeTitle: (name) => `${name}님에게 입학 축하 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 입학 축하와 응원 메시지를 남겨주세요!`
    },
    general: {
      key: 'general',
      label: '선물 펀딩',
      emoji: '🎁',
      enTitle: 'Congratulations!',
      introPhrase: '축하와 감사의 마음을 전해요!',
      ornament: '♡',
      subCaption: '소중한 마음을 담은 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 선물 펀딩`,
      defaultSubtitle: '소중한 마음을 모으는 위시리스트',
      pledgeTitle: (name) => `${name}님에게 선물 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 응원과 축하 메시지를 남겨주세요!`
    },
    custom: {
      key: 'custom',
      label: '직접 설정',
      emoji: '🎉',
      enTitle: 'Congratulations!',
      introPhrase: '축하합니다!',
      ornament: '✨',
      subCaption: '소중한 마음을 담은 선물 위시리스트가 열립니다',
      defaultHeadline: (name) => `${name}의 선물 펀딩`,
      defaultSubtitle: '소중한 마음을 모으는 위시리스트',
      pledgeTitle: (name) => `${name}님에게 선물 펀딩하기`,
      pledgePlaceholder: (name) => `${name}님에게 따뜻한 축하와 응원 메시지를 남겨주세요!`
    }
  };

  // Create default initial gifts for a new funding campaign
  function createInitialGiftsForCampaign(campaignId, hostName, eventType = 'general') {
    const cleanName = String(hostName || '주인공').trim();
    const cfg = EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.general;
    const isCustom = eventType === 'custom';
    const isGeneral = eventType === 'general';
    const gift3Title = (isCustom || isGeneral)
      ? `${cleanName}의 축하 스페셜 선물 & 꽃다발`
      : `${cleanName} ${cfg.label} 축하 선물 & 꽃다발`;
    const gift3Brand = (isCustom || isGeneral)
      ? '스페셜 기념 선물'
      : `${cfg.label} 기념 스페셜`;
    const gift3Desc = (isCustom || isGeneral)
      ? '특별한 날을 더욱 빛내줄 축하 선물 모금입니다.'
      : `${cfg.label}를 더욱 빛내줄 축하 선물 모금입니다.`;

    return [
      {
        id: `${campaignId}-gift-1`,
        campaignId,
        category: 'fashion',
        priority: 1,
        title: `${cleanName}의 1순위 위시 선물`,
        brand: '펀딩 주인 로그인 후 사진·이름·금액 수정 가능',
        goalAmount: 250000,
        description: '[✏️ 사진·내용 수정] 버튼을 눌러 실제 받고 싶은 선물 사진과 목표 금액을 등록해 보세요.',
        imageUrl: '',
        imageFit: 'cover'
      },
      {
        id: `${campaignId}-gift-2`,
        campaignId,
        category: 'fragrance',
        priority: 2,
        title: `${cleanName}의 2순위 위시 선물`,
        brand: '뷰티 / 향수 / 리빙 위시템',
        goalAmount: 150000,
        description: '원하는 선물 사진을 업로드하거나 목표 금액과 설명을 자유롭게 수정할 수 있습니다.',
        imageUrl: '',
        imageFit: 'cover'
      },
      {
        id: `${campaignId}-gift-3`,
        campaignId,
        category: 'cake',
        priority: 3,
        title: gift3Title,
        brand: gift3Brand,
        goalAmount: 70000,
        description: gift3Desc,
        imageUrl: '',
        imageFit: 'cover'
      }
    ];
  }

  function createEmptyCampaignState(campaignId = '', hostName = '주인공', eventType = 'general') {
    const cleanName = String(hostName || '주인공').trim();
    const cfg = EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.general;
    return {
      campaign: {
        id: campaignId,
        hostName: cleanName,
        emoji: cfg.emoji,
        birthdayDate: getTodayDateString(),
        headline: cfg.defaultHeadline(cleanName),
        subtitle: cfg.defaultSubtitle,
        bio: `${cleanName}님이 받고 싶은 위시리스트에 원하는 금액만큼 마음을 보태주세요. 응원 메시지와 함께 송금하시면 입금 확인을 거쳐 달성률에 반영됩니다.`,
        kakaoRemitUrl: '',
        tossRemitUrl: '',
        bankName: '',
        bankAccount: '',
        introImageUrl: '',
        introImageFit: 'cover',
        pendingDeleteImageUrl: '',
        eventType: cfg.key,
        introMessage: ''
      },
      gifts: campaignId ? createInitialGiftsForCampaign(campaignId, cleanName, eventType) : [],
      contributions: [],
      replies: []
    };
  }

  // Active Routing & Application State
  let currentCampaignId = getCampaignIdFromUrl();
  let state = createEmptyCampaignState(currentCampaignId);
  let cheeredIdsSet = loadCheeredIds();
  let currentGiftFilter = 'all';
  let currentGiftSort = 'priority';
  const expandedGiftDescIds = new Set();
  const openReplyThreadIds = new Set();
  const openReplyFormIds = new Set();
  let currentMessageSearch = '';
  let currentMessageGiftFilter = 'all';
  let currentStatusFilter = 'all';
  let selectedCardTheme = 'warm-cream';
  let currentGiftMaxTarget = 300000;
  let lastCreatedCampaignId = '';

  // Supabase Client, Realtime & Campaign Owner Session State
  let supabaseClient = null;
  let realtimeChannel = null;
  let pollIntervalId = null;
  let isCloudConnected = false;
  let isCurrentCampaignCloud = false;
  let lastSupabaseSyncError = '';
  let isAdminAuthenticated = false; // True only when verified as the owner of currentCampaignId
  let isSubmittingPledge = false;
  let lastSubmitTimestamp = 0;
  let currentSelectedRemitMethod = 'bank';

  // Temporary Photo State inside Gift Editor Modal
  let editorPhotoDataUrl = '';
  let editorPhotoBlob = null;
  let editorPhotoMime = 'image/webp';

  // Temporary Participant Profile Photo State inside Pledge Modal
  let pledgeAvatarDataUrl = '';
  let pledgeAvatarBlob = null;
  let pledgeAvatarMime = 'image/webp';

  // Temporary Participant Profile Photo State inside Self-Service Avatar Manage Modal
  let manageAvatarDataUrl = '';
  let manageAvatarBlob = null;
  let manageAvatarMime = 'image/webp';
  let manageAvatarRemoved = false;

  // =========================================================================
  // URL ROUTING & SESSION HELPERS
  // =========================================================================
  function getCampaignIdFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return (params.get('f') || '').trim();
    } catch (e) {
      return '';
    }
  }

  function buildCampaignShareUrl(campaignId) {
    try {
      const u = new URL(window.location.href);
      if (u.pathname.endsWith('/index.html')) {
        u.pathname = u.pathname.slice(0, -10) || '/';
      }
      u.search = '';
      u.hash = '';
      u.searchParams.set('f', campaignId);
      return u.toString();
    } catch (e) {
      const path = (window.location.pathname || '').replace(/\/index\.html$/, '') || '/';
      return `${window.location.origin}${path}?f=${encodeURIComponent(campaignId)}`;
    }
  }

  function extractCampaignIdFromInput(rawInput) {
    const trimmed = String(rawInput || '').trim();
    if (!trimmed) return '';
    try {
      if (trimmed.includes('?f=') || trimmed.includes('&f=') || trimmed.startsWith('http')) {
        const parsed = new URL(trimmed, window.location.origin);
        const fParam = (parsed.searchParams.get('f') || '').trim();
        if (fParam) return fParam;
      }
    } catch (e) {
      // Ignore URL parse error and treat as raw ID
    }
    return trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function getStoredOwnerSessionToken(campaignId) {
    if (!campaignId) return '';
    try {
      return sessionStorage.getItem(OWNER_SESSION_PREFIX + campaignId) || '';
    } catch (e) {
      return '';
    }
  }

  function saveOwnerSessionToken(campaignId, token) {
    if (!campaignId) return;
    try {
      if (token) {
        sessionStorage.setItem(OWNER_SESSION_PREFIX + campaignId, token);
      } else {
        sessionStorage.removeItem(OWNER_SESSION_PREFIX + campaignId);
      }
    } catch (e) {
      // Ignore
    }
  }

  // =========================================================================
  // DEVICE-CREATED FUNDING STORE (My Created Fundings Only, Never Visit History)
  // =========================================================================
  function getMyCreatedFundings() {
    try {
      const raw = localStorage.getItem(MY_CREATED_FUNDINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return [];
  }

  function saveMyCreatedFundings(list) {
    try {
      localStorage.setItem(MY_CREATED_FUNDINGS_STORAGE_KEY, JSON.stringify(list || []));
    } catch (e) {}
  }

  function addMyCreatedFunding(item) {
    if (!item || !item.id) return;
    try {
      let list = getMyCreatedFundings();
      // Remove duplicate if already present
      list = list.filter((x) => x.id !== item.id);
      list.unshift({
        id: item.id,
        hostName: item.hostName || '주인공',
        eventType: item.eventType || 'general',
        headline: item.headline || `${item.hostName || '주인공'}의 선물 펀딩`,
        createdAt: item.createdAt || new Date().toISOString()
      });
      // Limit to 50 max
      if (list.length > 50) list = list.slice(0, 50);
      saveMyCreatedFundings(list);
    } catch (e) {}
  }

  function removeMyCreatedFunding(id) {
    if (!id) return;
    try {
      let list = getMyCreatedFundings();
      list = list.filter((x) => x.id !== id);
      saveMyCreatedFundings(list);
    } catch (e) {}
  }

  function migrateLegacyDeviceCampaigns() {
    try {
      let list = getMyCreatedFundings();
      const existingIds = new Set(list.map((x) => x.id));
      let changed = false;

      // Scan sessionStorage and localStorage for any stored owner tokens
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(OWNER_SESSION_PREFIX)) {
          const cid = key.replace(OWNER_SESSION_PREFIX, '').trim();
          if (cid && !existingIds.has(cid)) {
            list.unshift({
              id: cid,
              hostName: '내 펀딩',
              eventType: 'general',
              headline: '이 기기에서 생성·관리했던 펀딩',
              createdAt: new Date().toISOString()
            });
            existingIds.add(cid);
            changed = true;
          }
        }
      }

      // Check local multi db as well
      const localDb = loadLocalMultiDb();
      if (localDb && localDb.campaigns) {
        Object.keys(localDb.campaigns).forEach((cid) => {
          if (!existingIds.has(cid)) {
            const c = localDb.campaigns[cid]?.campaign || {};
            list.unshift({
              id: cid,
              hostName: c.hostName || '내 펀딩',
              eventType: c.eventType || 'general',
              headline: c.headline || '이 기기에서 생성한 펀딩',
              createdAt: new Date().toISOString()
            });
            existingIds.add(cid);
            changed = true;
          }
        });
      }

      if (changed) {
        saveMyCreatedFundings(list);
      }
    } catch (e) {}
  }

  // Local Multi-Campaign Store (Used when testing before connecting Supabase)
  function loadLocalMultiDb() {
    try {
      const raw = localStorage.getItem(LOCAL_MULTI_DB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.campaigns) {
          return parsed;
        }
      }
    } catch (e) {
      // Ignore
    }
    return { campaigns: {} };
  }

  function saveLocalMultiDb(dbObj) {
    try {
      localStorage.setItem(LOCAL_MULTI_DB_KEY, JSON.stringify(dbObj));
    } catch (e) {
      // Ignore
    }
  }

  function saveCurrentStateToLocalMultiDb(ownerPwHash, ownerPwSalt) {
    if (!currentCampaignId) return;
    const db = loadLocalMultiDb();
    const existing = db.campaigns[currentCampaignId] || {};
    db.campaigns[currentCampaignId] = {
      campaign: { ...state.campaign, id: currentCampaignId },
      gifts: state.gifts,
      contributions: state.contributions,
      replies: state.replies || [],
      ownerPwSalt: ownerPwSalt || existing.ownerPwSalt || '',
      ownerPwHash: ownerPwHash || existing.ownerPwHash || '',
      failedAttempts: existing.failedAttempts || 0,
      lockedUntil: existing.lockedUntil || 0
    };
    saveLocalMultiDb(db);
  }

  function getValidHttpUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.href;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function normalizeWebUrl(rawUrl) {
    let trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) {
      return '';
    }
    return '';
  }

  // Supabase Project URL 정규화:
  // 사용자가 Data API 주소(예: https://xxx.supabase.co/rest/v1/)를 입력하더라도
  // supabase.createClient()가 내부적으로 '/rest/v1'과 '/rpc/...'를 붙이므로
  // 중복 경로('/rest/v1/rest/v1/rpc/...')로 인한 PGRST125(Invalid path specified in request URL) 오류를 방지합니다.
  function normalizeSupabaseProjectUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null;
      }
      const cleanedPath = parsed.pathname
        .replace(/\/+(rest|auth|storage|realtime|functions)\/v\d+(\/.*)?$/i, '')
        .replace(/\/+rpc(\/.*)?$/i, '')
        .replace(/\/+$/, '');
      return `${parsed.origin}${cleanedPath}`;
    } catch (e) {
      return null;
    }
  }

  function isForbiddenServiceRoleKey(jwtStr) {
    const trimmed = String(jwtStr || '').trim();
    if (!trimmed) return false;
    if (trimmed.includes('service_role') || trimmed.startsWith('sb_secret_')) return true;
    const parts = trimmed.split('.');
    if (parts.length === 3) {
      try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = JSON.parse(atob(base64));
        if (jsonPayload && jsonPayload.role === 'service_role') {
          return true;
        }
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function loadCheeredIds() {
    try {
      const raw = localStorage.getItem(CHEERED_IDS_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (e) {
      // Ignore
    }
    return new Set();
  }

  function saveCheeredIds() {
    try {
      localStorage.setItem(CHEERED_IDS_STORAGE_KEY, JSON.stringify(Array.from(cheeredIdsSet)));
    } catch (e) {
      // Ignore
    }
  }

  function resolveSupabaseConnectionConfig() {
    let url = (DEFAULT_SUPABASE_CONFIG.url || SUPABASE_PROJECT_URL || '').trim();
    let anonKey = (
      DEFAULT_SUPABASE_CONFIG.publishableKey ||
      DEFAULT_SUPABASE_CONFIG.anonKey ||
      SUPABASE_PUBLISHABLE_KEY ||
      ''
    ).trim();
    let bucket = (DEFAULT_SUPABASE_CONFIG.bucket || DEFAULT_BUCKET_NAME).trim() || DEFAULT_BUCKET_NAME;

    try {
      const savedRaw = localStorage.getItem(SUPABASE_CONN_STORAGE_KEY);
      if (savedRaw) {
        const saved = JSON.parse(savedRaw);
        const normalizedSavedUrl = normalizeSupabaseProjectUrl(saved.url);
        if (normalizedSavedUrl) {
          url = normalizedSavedUrl;
        }
        if (saved.anonKey && !isForbiddenServiceRoleKey(saved.anonKey)) {
          anonKey = String(saved.anonKey).trim();
        }
        if (saved.bucket) {
          bucket = String(saved.bucket).trim() || DEFAULT_BUCKET_NAME;
        }
        // 기존 localStorage에 '/rest/v1/' 등이 포함된 URL이 저장되어 있었다면 정규화된 URL로 즉시 자동 보정
        if (saved.url && normalizedSavedUrl && saved.url !== normalizedSavedUrl) {
          localStorage.setItem(
            SUPABASE_CONN_STORAGE_KEY,
            JSON.stringify({ url: normalizedSavedUrl, anonKey, bucket })
          );
        }
      }
    } catch (e) {
      // Ignore
    }

    try {
      const params = new URLSearchParams(window.location.search);
      const qUrl = params.get('sb_url');
      const qKey = params.get('sb_key');
      const qBucket = params.get('sb_bucket');
      const normalizedQueryUrl = normalizeSupabaseProjectUrl(qUrl);
      if (normalizedQueryUrl && qKey && !isForbiddenServiceRoleKey(qKey)) {
        url = normalizedQueryUrl;
        anonKey = qKey.trim();
        if (qBucket) bucket = qBucket.trim() || DEFAULT_BUCKET_NAME;
        localStorage.setItem(SUPABASE_CONN_STORAGE_KEY, JSON.stringify({ url, anonKey, bucket }));
      }
    } catch (e) {
      // Ignore
    }

    return {
      url: normalizeSupabaseProjectUrl(url) || '',
      anonKey: isForbiddenServiceRoleKey(anonKey) ? '' : anonKey,
      bucket: bucket || DEFAULT_BUCKET_NAME
    };
  }

  function saveSupabaseConnectionConfig(url, anonKey, bucket) {
    const cleanUrl = normalizeSupabaseProjectUrl(url) || '';
    const cleanBucket = (bucket || DEFAULT_BUCKET_NAME).trim() || DEFAULT_BUCKET_NAME;
    try {
      localStorage.setItem(
        SUPABASE_CONN_STORAGE_KEY,
        JSON.stringify({ url: cleanUrl, anonKey, bucket: cleanBucket })
      );
    } catch (e) {
      // Ignore
    }
  }

  function generateRandomHex(byteCount = 8) {
    const arr = new Uint8Array(byteCount);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < byteCount; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Offline local fallback hash helper (when Supabase is not connected yet)
  function computeLocalHash(secret, salt) {
    const raw = `bday-local-hash-v1::${salt}::${String(secret).trim()}`;
    let h1 = 0xdeadbeef ^ raw.length;
    let h2 = 0x41c6ce57 ^ raw.length;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  function isSupabaseConfigured() {
    const cfg = resolveSupabaseConnectionConfig();
    return Boolean(cfg.url && cfg.anonKey && cfg.anonKey.length > 15 && cfg.bucket);
  }

  // Format Supabase RPC and Storage errors with exact code, message, details, and hints
  function formatSupabaseRpcError(err, resData, fallbackMsg = '요청 처리에 실패했습니다.') {
    if (err) {
      const parts = [];
      if (err.code) parts.push(`[오류코드 ${err.code}]`);
      if (err.statusCode) parts.push(`[HTTP ${err.statusCode}]`);
      if (err.message) parts.push(err.message);
      if (err.error && err.error !== err.message) parts.push(`(${err.error})`);
      if (err.details) parts.push(`- 상세: ${err.details}`);
      if (err.hint) parts.push(`- 힌트: ${err.hint}`);
      const joined = parts.join(' ').trim();
      return joined || fallbackMsg;
    }
    if (resData && resData.ok === false) {
      return resData.message || fallbackMsg;
    }
    return fallbackMsg;
  }

  // =========================================================================
  // 1. SUPABASE INITIALIZATION, ROUTING & CAMPAIGN SYNC
  // =========================================================================
  async function initSupabaseAndRoute() {
    const cfg = resolveSupabaseConnectionConfig();
    lastSupabaseSyncError = '';

    if (cfg.url && cfg.anonKey && window.supabase && window.supabase.createClient) {
      try {
        supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
          auth: { persistSession: false }
        });
        // 실제 REST 엔드포인트와 테이블 응답 가능 여부를 즉시 검증
        const { error: pingErr } = await supabaseClient.from('campaigns').select('id').limit(1);
        if (pingErr) {
          lastSupabaseSyncError = pingErr.message || 'Supabase 테이블 조회 실패';
          console.warn('Supabase 연결 확인 실패:', pingErr);
          isCloudConnected = false;
        } else {
          isCloudConnected = true;
        }
      } catch (e) {
        lastSupabaseSyncError = e.message || 'Supabase 클라이언트 초기화 실패';
        console.warn('Supabase 클라이언트 초기화 실패:', e);
        supabaseClient = null;
        isCloudConnected = false;
      }
    } else {
      supabaseClient = null;
      isCloudConnected = false;
    }

    await routeToCurrentView(false);
  }

  async function navigateToFunding(campaignId, playIntro = true) {
    const cleanId = String(campaignId || '').trim();
    if (!cleanId) {
      navigateToHome();
      return;
    }
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('f', cleanId);
      window.history.pushState({ f: cleanId }, '', nextUrl.toString());
    } catch (e) {
      window.location.search = `?f=${encodeURIComponent(cleanId)}`;
      return;
    }
    await routeToCurrentView(playIntro);
  }

  function navigateToHome() {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    currentCampaignId = '';
    isAdminAuthenticated = false;
    isCurrentCampaignCloud = false;
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('f');
      window.history.pushState({}, '', nextUrl.toString());
    } catch (e) {
      // Ignore
    }
    finishBirthdayIntro();
    updateViewModeUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function routeToCurrentView(forcePlayIntro = false) {
    currentCampaignId = getCampaignIdFromUrl();

    if (!currentCampaignId) {
      isAdminAuthenticated = false;
      isCurrentCampaignCloud = false;
      finishBirthdayIntro();
      updateViewModeUI();
      checkFirstVisitGuideOnLoad();
      return;
    }

    // Load campaign data from Supabase or Local Multi DB
    let loadedOk = false;
    if (isCloudConnected && supabaseClient) {
      loadedOk = await fetchCampaignFromSupabase(currentCampaignId, false);
      if (loadedOk) {
        isCurrentCampaignCloud = true;
        await verifyCurrentCampaignOwnerSession();
        setupRealtimeForCurrentCampaign(currentCampaignId);
      } else {
        loadedOk = loadCampaignFromLocalMultiDb(currentCampaignId);
      }
    } else {
      loadedOk = loadCampaignFromLocalMultiDb(currentCampaignId);
    }

    if (!loadedOk) {
      showToast('해당 고유 ID의 펀딩을 찾을 수 없습니다. 새 펀딩을 만들어 보세요!');
      navigateToHome();
      return;
    }

    updateViewModeUI();
    renderApp();
    await prepareAndBindIntro();
    startBirthdayIntroAnimation(forcePlayIntro);
  }

  function setupRealtimeForCurrentCampaign(campaignId) {
    if (!supabaseClient || !campaignId) return;

    if (realtimeChannel) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    realtimeChannel = supabaseClient
      .channel(`bday-campaign-${campaignId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaigns', filter: `id=eq.${campaignId}` },
        () => fetchCampaignFromSupabase(campaignId, true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'gifts', filter: `campaign_id=eq.${campaignId}` },
        () => fetchCampaignFromSupabase(campaignId, true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contributions', filter: `campaign_id=eq.${campaignId}` },
        () => fetchCampaignFromSupabase(campaignId, true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contribution_replies', filter: `campaign_id=eq.${campaignId}` },
        () => fetchCampaignFromSupabase(campaignId, true)
      )
      .subscribe();

    if (pollIntervalId) clearInterval(pollIntervalId);
    pollIntervalId = setInterval(() => {
      if (document.visibilityState === 'visible' && isCloudConnected && currentCampaignId) {
        fetchCampaignFromSupabase(currentCampaignId, true);
      }
    }, 12000);
  }

  async function verifyCurrentCampaignOwnerSession() {
    if (!currentCampaignId) {
      isAdminAuthenticated = false;
      updateAdminModeUI();
      return false;
    }

    const token = getStoredOwnerSessionToken(currentCampaignId);
    if (!token) {
      isAdminAuthenticated = false;
      updateAdminModeUI();
      return false;
    }

    if (isCloudConnected && supabaseClient) {
      try {
        const { data, error } = await supabaseClient.rpc('owner_check_session', {
          p_campaign_id: currentCampaignId,
          p_session_token: token
        });
        if (error || data !== true) {
          saveOwnerSessionToken(currentCampaignId, '');
          isAdminAuthenticated = false;
        } else {
          isAdminAuthenticated = true;
        }
      } catch (e) {
        isAdminAuthenticated = false;
      }
    } else {
      // Local mode token check (strictly bound to campaignId)
      isAdminAuthenticated = token.startsWith(`local-owner-${currentCampaignId}-`);
    }

    updateAdminModeUI();
    return isAdminAuthenticated;
  }

  function loadCampaignFromLocalMultiDb(campaignId) {
    const db = loadLocalMultiDb();
    const record = db.campaigns[campaignId];
    if (!record || !record.campaign) return false;

    isCurrentCampaignCloud = false;
    state = {
      campaign: { ...record.campaign, id: campaignId },
      gifts: Array.isArray(record.gifts) ? record.gifts : [],
      contributions: Array.isArray(record.contributions)
        ? record.contributions.map((c) => ({
            ...c,
            cheeredByMe: cheeredIdsSet.has(c.id)
          }))
        : [],
      replies: Array.isArray(record.replies) ? record.replies : []
    };

    const token = getStoredOwnerSessionToken(campaignId);
    isAdminAuthenticated = Boolean(token && token.startsWith(`local-owner-${campaignId}-`));
    return true;
  }

  async function fetchCampaignFromSupabase(campaignId, silent = false) {
    if (!supabaseClient || !campaignId) return false;
    try {
      const [campRes, giftsRes, contribRes] = await Promise.all([
        supabaseClient.from('campaigns').select('*').eq('id', campaignId).maybeSingle(),
        supabaseClient
          .from('gifts')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('priority', { ascending: true })
          .order('created_at', { ascending: true }),
        supabaseClient
          .from('contributions')
          .select('id,campaign_id,gift_id,sender_name,relation,amount,message,avatar_url,theme,status,cheers,created_at_label,created_at')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: true })
      ]);

      if (campRes.error) {
        lastSupabaseSyncError = campRes.error.message || '캠페인 조회 오류';
        if (!silent) console.warn('캠페인 조회 오류:', campRes.error);
        return false;
      }

      if (!campRes.data) {
        return false;
      }

      const c = campRes.data;
      const loadedEventType = c.event_type || 'general';
      const eventCfg = EVENT_TYPE_CONFIG[loadedEventType] || EVENT_TYPE_CONFIG.general;
      const cleanHost = c.host_name || '주인공';
      state.campaign = {
        id: c.id,
        hostName: cleanHost,
        emoji: c.emoji || eventCfg.emoji || '🎁',
        birthdayDate: c.birthday_date || getTodayDateString(),
        headline: c.headline || eventCfg.defaultHeadline(cleanHost),
        subtitle: c.subtitle || eventCfg.defaultSubtitle,
        bio: c.bio || '',
        bankName: c.bank_name || '',
        bankAccount: c.bank_account || '',
        kakaoRemitUrl: c.kakao_remit_url || '',
        tossRemitUrl: c.toss_remit_url || '',
        introImageUrl: c.intro_image_url || '',
        introImageFit: c.intro_image_fit === 'contain' ? 'contain' : 'cover',
        pendingDeleteImageUrl: c.pending_delete_image_url || '',
        eventType: loadedEventType,
        introMessage: c.intro_message || ''
      };

      if (Array.isArray(giftsRes.data)) {
        state.gifts = giftsRes.data.map((g) => ({
          id: g.id,
          campaignId: g.campaign_id,
          category: g.category || 'fashion',
          priority: Number(g.priority) || 1,
          title: g.title || '위시 선물',
          brand: g.brand || '',
          goalAmount: Number(g.goal_amount) || 100000,
          description: g.description || '',
          imageUrl: g.image_url || '',
          imageFit: g.image_fit === 'contain' ? 'contain' : 'cover',
          productUrl: g.product_url || ''
        }));
      }

      if (Array.isArray(contribRes.data)) {
        state.contributions = contribRes.data.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          giftId: row.gift_id,
          senderName: row.sender_name,
          relation: row.relation || '친구',
          amount: Number(row.amount) || 0,
          message: row.message || '',
          avatarUrl: row.avatar_url || '',
          theme: row.theme || 'warm-cream',
          status: row.status === 'approved' ? 'approved' : 'pending',
          cheers: Number(row.cheers) || 0,
          cheeredByMe: cheeredIdsSet.has(row.id),
          createdAt: row.created_at_label || formatIsoTimestamp(row.created_at)
        }));
      }

      // Fetch contribution replies (safe fallback if migration not yet applied)
      let repliesData = [];
      try {
        const repliesRes = await supabaseClient
          .from('contribution_replies')
          .select('id,campaign_id,contribution_id,author_name,content,is_host,created_at')
          .eq('campaign_id', campaignId)
          .eq('is_hidden', false)
          .order('created_at', { ascending: true });
        if (!repliesRes.error && Array.isArray(repliesRes.data)) {
          repliesData = repliesRes.data;
        }
      } catch (err) {
        // Table not yet migrated
      }

      state.replies = repliesData.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        contributionId: row.contribution_id,
        authorName: row.author_name || '익명',
        content: row.content || '',
        isHost: Boolean(row.is_host),
        createdAt: row.created_at,
        createdAtLabel: formatIsoTimestamp(row.created_at)
      }));

      isCloudConnected = true;
      renderApp();
      return true;
    } catch (e) {
      if (!silent) console.warn('Supabase 캠페인 조회 실패:', e);
      return false;
    }
  }

  function formatIsoTimestamp(isoStr) {
    if (!isoStr) return '방금 전';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (e) {
      return '방금 전';
    }
  }

  function requireAdminPermission(actionName = '이 작업') {
    if (!isAdminAuthenticated) {
      showToast(`🔒 ${actionName}은(는) 펀딩 주인 비밀번호 인증 후에만 수행할 수 있습니다.`);
      openAdminAuthModal();
      return false;
    }
    return true;
  }

  function updateViewModeUI() {
    const isFundingView = Boolean(currentCampaignId);
    const createView = document.getElementById('createFundingView');
    const fundingView = document.getElementById('fundingPageView');
    const navLinks = document.getElementById('fundingNavLinks');

    if (createView) createView.hidden = isFundingView;
    if (fundingView) fundingView.hidden = !isFundingView;
    if (navLinks) navLinks.hidden = !isFundingView;

    document.querySelectorAll('.funding-only-ui').forEach((el) => {
      el.hidden = !isFundingView;
    });

    if (!isFundingView) {
      document.title = 'personal_funding — 특별한 날, 마음을 모으는 선물 펀딩';
      document.getElementById('topBrandTitle').textContent = 'personal_funding';
      document.getElementById('topBrandSub').textContent = '나만의 선물 위시리스트';
      document.getElementById('footerBrandTitle').textContent = 'personal_funding — 특별한 날, 마음을 모으는 선물 펀딩';
      document.getElementById('pendingAlertBanner').hidden = true;
    }

    updateAdminModeUI();
    renderCloudStatusPill();
  }

  function updateAdminModeUI() {
    const isFundingView = Boolean(currentCampaignId);
    const activeAdmin = isFundingView && isAdminAuthenticated;

    document.body.classList.toggle('is-admin-mode', activeAdmin);

    document.querySelectorAll('.admin-only-ui').forEach((el) => {
      if (el.id === 'pendingAlertBanner') return;
      el.hidden = !activeAdmin;
    });

    const adminAuthBtnText = document.getElementById('adminAuthBtnText');
    const mobileAdminAuthBtn = document.getElementById('mobileAdminAuthBtn');
    const loginForm = document.getElementById('adminLoginForm');
    const loggedInBox = document.getElementById('adminLoggedInBox');
    const emailDisplay = document.getElementById('adminUserEmailDisplay');
    const ownerSectionBox = document.getElementById('ownerAuthSectionBox');
    const authFundingLabel = document.getElementById('authModalFundingLabel');

    if (ownerSectionBox) {
      ownerSectionBox.hidden = !isFundingView;
    }
    if (authFundingLabel && isFundingView) {
      authFundingLabel.textContent = `${state.campaign.hostName}의 펀딩 (${currentCampaignId})`;
    }

    if (activeAdmin) {
      if (adminAuthBtnText) adminAuthBtnText.textContent = '🔓 펀딩 주인 모드';
      if (mobileAdminAuthBtn) mobileAdminAuthBtn.textContent = `🔓 펀딩 주인 모드 (${state.campaign.hostName})`;
      if (loginForm) loginForm.hidden = true;
      if (loggedInBox) loggedInBox.hidden = false;
      if (emailDisplay) emailDisplay.textContent = `${state.campaign.hostName} (${currentCampaignId})`;
    } else {
      if (adminAuthBtnText) adminAuthBtnText.textContent = '🔐 펀딩 주인 로그인';
      if (mobileAdminAuthBtn) {
        mobileAdminAuthBtn.textContent = isFundingView
          ? '🔐 펀딩 주인 로그인 / DB 설정'
          : '☁️ 개발용 Supabase DB 연결 설정';
      }
      if (loginForm) loginForm.hidden = false;
      if (loggedInBox) loggedInBox.hidden = true;
    }
  }

  function renderCloudStatusPill() {
    const syncDot = document.getElementById('cloudSyncDot');
    const syncText = document.getElementById('cloudSyncStatusText');
    const footerNote = document.getElementById('footerStorageStatusNote');

    if (syncDot && syncText) {
      if (isCloudConnected) {
        syncDot.classList.add('configured');
        syncText.textContent = '☁️ 실시간 DB 연결됨';
      } else {
        syncDot.classList.remove('configured');
        syncText.textContent = '☁️ 개발용 DB 연결';
      }
    }

    if (footerNote) {
      if (isCloudConnected) {
        footerNote.textContent =
          '☁️ personal_funding — 현재 Supabase 데이터베이스와 연결되어 있습니다. 각 펀딩은 고유 URL별로 격리되어 실시간 공유됩니다.';
      } else {
        footerNote.textContent =
          '💡 personal_funding — 현재 로컬 미리보기 모드입니다. 다른 기기와 공유하려면 상단 [☁️ 개발용 DB 연결]에서 personal_funding Supabase 프로젝트를 연결해 주세요.';
      }
    }
  }

  // =========================================================================
  // 2. CREATE NEW FUNDING CAMPAIGN LOGIC (Security Notice + No Password Recovery)
  // =========================================================================
  async function handleCreateFundingSubmit(e) {
    e.preventDefault();

    const hostName = document.getElementById('createHostNameInput').value.trim();
    const birthdayDate = document.getElementById('createBirthdayDateInput').value || getTodayDateString();
    const password = document.getElementById('createAdminPasswordInput').value.trim();
    const passwordConfirm = document.getElementById('createAdminPasswordConfirmInput').value.trim();
    const emoji = document.getElementById('createEmojiSelect').value || '🎂';
    const customHeadline = document.getElementById('createHeadlineInput').value.trim();
    const bankName = document.getElementById('createBankNameInput').value.trim();
    const bankAccount = document.getElementById('createBankAccountInput').value.trim();
    const rawKakao = document.getElementById('createKakaoUrlInput').value.trim();
    const rawToss = document.getElementById('createTossUrlInput').value.trim();
    const honeypot = document.getElementById('createHoneypotInput').value;
    const securityConfirmed = document.getElementById('createSecurityConfirmCheck').checked;
    const errEl = document.getElementById('createFundingErrorMsg');
    const submitBtn = document.getElementById('createFundingSubmitBtn');

    errEl.hidden = true;

    if (honeypot) {
      errEl.textContent = '비정상적인 요청이 감지되었습니다.';
      errEl.hidden = false;
      return;
    }

    if (!hostName || hostName.length > 24) {
      errEl.textContent = '주인공 이름을 1~24자로 입력해 주세요.';
      errEl.hidden = false;
      document.getElementById('createHostNameInput').focus();
      return;
    }

    if (password.length < 8 || password.length > 64) {
      errEl.textContent = '관리 비밀번호는 8자 이상 64자 이하로 설정해 주세요.';
      errEl.hidden = false;
      document.getElementById('createAdminPasswordInput').focus();
      return;
    }

    if (password !== passwordConfirm) {
      errEl.textContent = '관리 비밀번호와 비밀번호 확인이 일치하지 않습니다.';
      errEl.hidden = false;
      document.getElementById('createAdminPasswordConfirmInput').focus();
      return;
    }

    if (rawKakao && !getValidHttpUrl(rawKakao)) {
      errEl.textContent = '카카오페이 송금 링크는 https:// 로 시작하는 유효한 웹 주소여야 합니다.';
      errEl.hidden = false;
      document.getElementById('createKakaoUrlInput').focus();
      return;
    }

    if (rawToss && !getValidHttpUrl(rawToss)) {
      errEl.textContent = '토스 송금 링크는 https:// 로 시작하는 유효한 웹 주소여야 합니다.';
      errEl.hidden = false;
      document.getElementById('createTossUrlInput').focus();
      return;
    }

    if (!securityConfirmed) {
      errEl.textContent = '펀딩 생성 전 [⚠️ 보안 안내] 및 [관리 비밀번호 분실 시 복구 불가 안내] 확인에 체크해 주세요.';
      errEl.hidden = false;
      document.getElementById('createSecurityConfirmCheck').focus();
      return;
    }

    const eventTypeSelect = document.getElementById('createEventTypeSelect');
    const eventType = (eventTypeSelect && eventTypeSelect.value) || '';
    if (!eventType) {
      errEl.textContent = '펀딩 이벤트 종류를 선택해 주세요. (예: 생일, 졸업, 결혼, 일반 선물 등)';
      errEl.hidden = false;
      if (eventTypeSelect) eventTypeSelect.focus();
      return;
    }
    const customMsgInput = document.getElementById('createEventCustomTextInput');
    const customMsg = (customMsgInput && customMsgInput.value.trim()) || '';
    const eventCfg = EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.general;
    const eventLabel = eventType === 'custom' ? (customMsg || '축하') : eventCfg.label;

    const headline = customHeadline || eventCfg.defaultHeadline(hostName);
    const subtitle = eventCfg.defaultSubtitle;
    const bio = `${hostName}님이 받고 싶은 위시리스트에 원하는 금액만큼 마음을 보태주세요. 응원 메시지와 함께 송금하시면 입금 확인을 거쳐 달성률에 반영됩니다.`;

    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ 나만의 펀딩 생성 중...';

    try {
      let issuedCampaignId = '';
      let issuedToken = '';
      let issuedRecoveryCode = '';

      if (isCloudConnected && supabaseClient) {
        let rpcRes = await supabaseClient.rpc('create_funding_campaign', {
          p_host_name: hostName,
          p_password: password,
          p_birthday_date: birthdayDate,
          p_emoji: emoji,
          p_headline: headline,
          p_subtitle: subtitle,
          p_bio: bio,
          p_bank_name: bankName,
          p_bank_account: bankAccount,
          p_kakao_remit_url: rawKakao ? getValidHttpUrl(rawKakao) : '',
          p_toss_remit_url: rawToss ? getValidHttpUrl(rawToss) : '',
          p_honeypot: honeypot,
          p_event_type: eventType,
          p_intro_message: customMsg
        });

        // Pre-migration fallback: if 14-parameter function not found yet, call 12-param version
        if (rpcRes.error && /could not find the function/i.test(rpcRes.error.message || '')) {
          console.warn('[CreateCampaign] Falling back to 12-param create_funding_campaign');
          rpcRes = await supabaseClient.rpc('create_funding_campaign', {
            p_host_name: hostName,
            p_password: password,
            p_birthday_date: birthdayDate,
            p_emoji: emoji,
            p_headline: headline,
            p_subtitle: subtitle,
            p_bio: bio,
            p_bank_name: bankName,
            p_bank_account: bankAccount,
            p_kakao_remit_url: rawKakao ? getValidHttpUrl(rawKakao) : '',
            p_toss_remit_url: rawToss ? getValidHttpUrl(rawToss) : '',
            p_honeypot: honeypot
          });
        }

        const data = rpcRes.data;
        const error = rpcRes.error;

        if (error) {
          throw new Error(error.message || '펀딩 생성 중 오류가 발생했습니다.');
        }
        if (!data || data.ok === false || !data.campaign_id) {
          throw new Error((data && data.message) || '펀딩 생성 중 오류가 발생했습니다.');
        }

        issuedCampaignId = data.campaign_id;
        issuedToken = data.session_token || '';
        issuedRecoveryCode = data.recovery_code || '';
      } else {
        // Local preview fallback
        issuedCampaignId = 'f-' + generateRandomHex(5);
        issuedToken = `local-owner-${issuedCampaignId}-` + generateRandomHex(12);
        issuedRecoveryCode = 'RC-' + generateRandomHex(2).toUpperCase() + '-' + generateRandomHex(2).toUpperCase() + '-' + generateRandomHex(2).toUpperCase() + '-' + generateRandomHex(2).toUpperCase();
        const salt = generateRandomHex(6);
        const pwHash = computeLocalHash(password, salt);

        const db = loadLocalMultiDb();
        db.campaigns[issuedCampaignId] = {
          campaign: {
            id: issuedCampaignId,
            hostName,
            emoji,
            birthdayDate,
            headline,
            subtitle,
            bio,
            bankName,
            bankAccount,
            kakaoRemitUrl: rawKakao ? getValidHttpUrl(rawKakao) : '',
            tossRemitUrl: rawToss ? getValidHttpUrl(rawToss) : '',
            eventType,
            introMessage: customMsg
          },
          gifts: createInitialGiftsForCampaign(issuedCampaignId, hostName, eventType),
          contributions: [],
          replies: [],
          recoveryCode: issuedRecoveryCode,
          ownerPwSalt: salt,
          ownerPwHash: pwHash,
          failedAttempts: 0,
          lockedUntil: 0
        };
        saveLocalMultiDb(db);
      }

      saveOwnerSessionToken(issuedCampaignId, issuedToken);
      lastCreatedCampaignId = issuedCampaignId;

      // Optional Intro Photo upload & link (Decoupled: if photo fails, campaign is still preserved)
      const introFileInput = document.getElementById('createIntroPhotoInput');
      const introFile = introFileInput && introFileInput.files && introFileInput.files[0];
      const introFitSelect = document.getElementById('createIntroPhotoFitSelect');
      const introFit = (introFitSelect && introFitSelect.value === 'contain') ? 'contain' : 'cover';

      const fileOrBlobToUpload = createIntroPhotoCropBlob || introFile;

      if (fileOrBlobToUpload) {
        try {
          submitBtn.textContent = '🖼️ 인트로 사진 업로드 중...';
          if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
            const objectPath = await uploadIntroPhotoToStorage(fileOrBlobToUpload, issuedCampaignId);
            const { data: photoData, error: photoError } = await supabaseClient.rpc('owner_set_intro_photo', {
              p_campaign_id: issuedCampaignId,
              p_session_token: issuedToken,
              p_object_path: objectPath,
              p_intro_image_fit: introFit
            });

            if (photoError || !photoData || !photoData.ok) {
              await removeStorageObjectSafely(objectPath);
              const detailMsg = formatSupabaseRpcError(photoError, photoData, '사진 연결에 실패했습니다.');
              console.error('[IntroPhoto] owner_set_intro_photo error:', photoError, photoData);
              showToast(`⚠️ 펀딩은 생성되었으나 인트로 사진 연결 실패: ${detailMsg}. 관리자 설정에서 다시 등록할 수 있습니다.`, 8000);
            }
          } else {
            // Local preview fallback
            const finalDataUrl = createIntroPhotoCropDataUrl || await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = (ev) => resolve(ev.target.result);
              reader.readAsDataURL(fileOrBlobToUpload);
            });
            const db = loadLocalMultiDb();
            if (db.campaigns[issuedCampaignId]) {
              db.campaigns[issuedCampaignId].campaign.introImageUrl = finalDataUrl;
              db.campaigns[issuedCampaignId].campaign.introImageFit = introFit;
              saveLocalMultiDb(db);
            }
          }
        } catch (photoErr) {
          console.error('[IntroPhoto] Creation photo upload/link error:', photoErr);
          showToast(`⚠️ 펀딩은 생성되었으나 인트로 사진 등록 중 오류: ${photoErr.message}. 관리자 설정에서 다시 등록할 수 있습니다.`, 8000);
        }
      }

      if (introFileInput) introFileInput.value = '';
      createIntroPhotoRawSource = null;
      createIntroPhotoCropBlob = null;
      createIntroPhotoCropDataUrl = '';
      const previewWrap = document.getElementById('createIntroPhotoPreviewWrap');
      if (previewWrap) previewWrap.hidden = true;

      const shareUrl = buildCampaignShareUrl(issuedCampaignId);
      document.getElementById('createdSuccessTitle').textContent = `${hostName}님의 ${eventLabel} 펀딩이 생성되었습니다!`;
      document.getElementById('issuedFundingIdText').textContent = issuedCampaignId;
      document.getElementById('issuedShareUrlInput').value = shareUrl;

      const rcText = document.getElementById('issuedRecoveryCodeText');
      if (rcText) {
        rcText.textContent = issuedRecoveryCode || '발급 완료';
      }

      // Automatically register into this device's created fundings list
      addMyCreatedFunding({
        id: issuedCampaignId,
        hostName,
        eventType,
        headline,
        createdAt: new Date().toISOString()
      });

      document.getElementById('createFundingFormBox').hidden = true;
      document.getElementById('createdUrlSuccessBox').hidden = false;

      // Clear password fields immediately from DOM
      document.getElementById('createAdminPasswordInput').value = '';
      document.getElementById('createAdminPasswordConfirmInput').value = '';

      launchConfetti();
      showToast(`🎉 ${eventLabel} 펀딩이 생성되었습니다! 공유 URL과 관리 비밀번호를 꼭 보관해 주세요.`);
    } catch (err) {
      errEl.textContent = err.message || '펀딩 생성에 실패했습니다.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '✨ 내 펀딩 만들기 & 고유 URL 발급받기';
    }
  }

  // =========================================================================
  // 3. FORMATTING & IMAGE COMPRESSION HELPERS
  // =========================================================================
  function formatKRW(amount) {
    const num = Math.max(0, Math.round(Number(amount) || 0));
    return '₩' + num.toLocaleString('ko-KR');
  }

  function formatNumberKo(amount) {
    const num = Math.max(0, Math.round(Number(amount) || 0));
    return num.toLocaleString('ko-KR') + '원';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function validateImageFile(file) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      throw new Error('JPG, PNG, WEBP 형식의 이미지 파일만 업로드할 수 있습니다.');
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error('이미지 파일 용량은 5MB 이하여야 합니다.');
    }
  }

  function compressImageFile(file, maxDim = 720, quality = 0.84) {
    return new Promise((resolve, reject) => {
      try {
        validateImageFile(file);
      } catch (validationErr) {
        reject(validationErr);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('이미지 파일을 읽는 중 오류가 발생했습니다.'));
      reader.onload = (evt) => {
        const img = new Image();
        img.onerror = () => reject(new Error('올바른 이미지 파일이 아닙니다.'));
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          let outputMime = 'image/webp';
          let dataUrl = canvas.toDataURL(outputMime, quality);
          if (!dataUrl.startsWith('data:image/webp')) {
            outputMime = 'image/jpeg';
            dataUrl = canvas.toDataURL(outputMime, quality);
          }

          canvas.toBlob(
            (blob) => {
              resolve({ dataUrl, blob, mime: outputMime });
            },
            outputMime,
            quality
          );
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function compressAvatarFile(file, targetSize = 256, quality = 0.84) {
    return new Promise((resolve, reject) => {
      try {
        validateImageFile(file);
      } catch (validationErr) {
        reject(validationErr);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('프로필 사진을 읽는 중 오류가 발생했습니다.'));
      reader.onload = (evt) => {
        const img = new Image();
        img.onerror = () => reject(new Error('올바른 이미지 파일이 아닙니다.'));
        img.onload = () => {
          const minSide = Math.min(img.width, img.height);
          const sx = Math.round((img.width - minSide) / 2);
          const sy = Math.round((img.height - minSide) / 2);

          const outDim = Math.min(targetSize, minSide);
          const canvas = document.createElement('canvas');
          canvas.width = outDim;
          canvas.height = outDim;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, outDim, outDim);

          let outputMime = 'image/webp';
          let dataUrl = canvas.toDataURL(outputMime, quality);
          if (!dataUrl.startsWith('data:image/webp')) {
            outputMime = 'image/jpeg';
            dataUrl = canvas.toDataURL(outputMime, quality);
          }

          canvas.toBlob(
            (blob) => {
              resolve({ dataUrl, blob, mime: outputMime });
            },
            outputMime,
            quality
          );
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadToSupabaseStorage(blob, mime, folder = 'avatars') {
    const cfg = resolveSupabaseConnectionConfig();
    const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
    const ext = mime === 'image/webp' ? 'webp' : 'jpg';
    const randomId = generateRandomHex(8);
    const safeCid = (currentCampaignId || 'common').replace(/[^a-zA-Z0-9_-]/g, '');
    const objectPath = `${folder}/${safeCid}-${Date.now()}-${randomId}.${ext}`;

    if (supabaseClient && supabaseClient.storage) {
      const { error } = await supabaseClient.storage
        .from(bucketName)
        .upload(objectPath, blob, {
          contentType: mime,
          upsert: false
        });

      if (error) {
        throw new Error(`Supabase Storage (${bucketName}) 업로드 실패: ${error.message}`);
      }

      const { data: pubData } = supabaseClient.storage.from(bucketName).getPublicUrl(objectPath);
      if (pubData && pubData.publicUrl) {
        return pubData.publicUrl;
      }
    }

    throw new Error('Supabase Storage 연결을 확인해 주세요.');
  }

  // =========================================================================
  // PHOTO CROP & EDIT MANAGER (Cropper.js)
  // =========================================================================
  let activeCropper = null;
  let activeCropContext = null;
  let activeCropObjectUrl = null;
  let activeCropScaleX = 1;

  let createIntroPhotoRawSource = null;
  let createIntroPhotoCropBlob = null;
  let createIntroPhotoCropDataUrl = '';

  let giftPhotoRawSource = null;

  let profileIntroPhotoRawSource = null;
  let profileSelectedIntroBlob = null;
  let profileIntroPhotoCropDataUrl = '';

  async function resolveImageSourceToUrl(source) {
    if (!source) throw new Error('편집할 사진 소스가 없습니다.');
    if (typeof source === 'string') {
      if (source.startsWith('data:') || source.startsWith('blob:')) {
        return source;
      }
      // Remote URL: try fetch blob to prevent canvas cross-origin taint
      try {
        const resp = await fetch(source, { mode: 'cors' });
        if (resp.ok) {
          const b = await resp.blob();
          const objUrl = URL.createObjectURL(b);
          activeCropObjectUrl = objUrl;
          return objUrl;
        }
      } catch (e) {
        console.warn('[Cropper] Fetch remote image blob failed, using direct URL:', e);
      }
      return source;
    }
    if (source instanceof Blob || source instanceof File) {
      const objUrl = URL.createObjectURL(source);
      activeCropObjectUrl = objUrl;
      return objUrl;
    }
    throw new Error('지원되지 않는 이미지 소스 형식입니다.');
  }

  async function openPhotoCropModal({ source, initialAspect = 1, onApply, onCancel, originalMime = 'image/jpeg' }) {
    if (typeof Cropper === 'undefined') {
      showToast('⚠️ 사진 편집 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    closePhotoCropModal(false);

    const backdrop = document.getElementById('photoCropModalBackdrop');
    const targetImg = document.getElementById('cropperTargetImg');
    if (!backdrop || !targetImg) return;

    try {
      const resolvedSrc = await resolveImageSourceToUrl(source);
      activeCropContext = { source, initialAspect, onApply, onCancel, originalMime };
      activeCropScaleX = 1;

      targetImg.onload = () => {
        targetImg.onload = null;

        let aspectNum = NaN;
        if (initialAspect === 1 || initialAspect === '1') aspectNum = 1;
        else if (initialAspect === 0.8 || initialAspect === '0.8') aspectNum = 4 / 5;
        else if (initialAspect === 1.777777 || initialAspect === '16:9') aspectNum = 16 / 9;
        else if (initialAspect === 'free') aspectNum = NaN;
        else if (typeof initialAspect === 'number' && initialAspect > 0) aspectNum = initialAspect;

        document.querySelectorAll('.crop-ratio-btn').forEach((btn) => {
          const r = btn.getAttribute('data-ratio');
          const isMatch = (isNaN(aspectNum) && r === 'free') || (!isNaN(aspectNum) && r !== 'free' && Math.abs(Number(r) - aspectNum) < 0.05);
          btn.classList.toggle('active', isMatch);
        });

        const slider = document.getElementById('cropZoomSlider');
        if (slider) slider.value = 1;

        if (activeCropper) {
          activeCropper.destroy();
          activeCropper = null;
        }

        activeCropper = new Cropper(targetImg, {
          aspectRatio: aspectNum,
          viewMode: 1,
          dragMode: 'move',
          autoCropArea: 0.96,
          restore: false,
          modal: true,
          guides: true,
          center: true,
          highlight: false,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: true,
          preview: '#cropLivePreviewBox',
          zoomOnTouch: true,
          zoomOnWheel: true,
          responsive: true,
          ready() {
            if (slider) slider.value = 1;
          },
          zoom(e) {
            if (slider && e.detail && typeof e.detail.ratio === 'number') {
              slider.value = Math.min(3, Math.max(0.1, e.detail.ratio));
            }
          }
        });
      };

      targetImg.crossOrigin = 'anonymous';
      targetImg.src = resolvedSrc;

      backdrop.hidden = false;
      backdrop.setAttribute('aria-hidden', 'false');
    } catch (err) {
      console.error('[Cropper] Open modal error:', err);
      showToast(err.message || '사진 편집창을 여는 중 오류가 발생했습니다.');
    }
  }

  function closePhotoCropModal(triggerCancel = true) {
    if (triggerCancel && activeCropContext && typeof activeCropContext.onCancel === 'function') {
      try {
        activeCropContext.onCancel();
      } catch (e) {}
    }
    if (activeCropper) {
      activeCropper.destroy();
      activeCropper = null;
    }
    if (activeCropObjectUrl) {
      try {
        URL.revokeObjectURL(activeCropObjectUrl);
      } catch (e) {}
      activeCropObjectUrl = null;
    }
    activeCropContext = null;
    const backdrop = document.getElementById('photoCropModalBackdrop');
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
    }
    const targetImg = document.getElementById('cropperTargetImg');
    if (targetImg) {
      targetImg.src = '';
    }
  }

  async function uploadIntroPhotoToStorage(file, campaignId) {
    if (!file) throw new Error('업로드할 사진 파일이 없습니다.');
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error('사진 파일 크기는 최대 5MB까지 가능합니다.');
    }
    const mime = file.type || '';
    let ext = 'jpg';
    if (mime === 'image/png') ext = 'png';
    else if (mime === 'image/webp') ext = 'webp';
    else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
    else {
      const nameExt = (file.name || '').split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp'].includes(nameExt)) {
        ext = nameExt === 'jpeg' ? 'jpg' : nameExt;
      } else {
        ext = 'jpg';
      }
    }

    const safeCid = String(campaignId || '').trim();
    if (!safeCid) throw new Error('유효한 펀딩 ID가 없습니다.');

    const timestamp = Date.now();
    const randomPart = generateRandomHex(8); // exactly 16 hex characters
    const objectPath = `intros/${safeCid}-${timestamp}-${randomPart}.${ext}`;

    const cfg = resolveSupabaseConnectionConfig();
    const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();

    if (!supabaseClient || !supabaseClient.storage) {
      throw new Error('Supabase Storage 연결을 확인해 주세요.');
    }

    const { error } = await supabaseClient.storage
      .from(bucketName)
      .upload(objectPath, file, {
        contentType: mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'),
        upsert: false
      });

    if (error) {
      console.error('[IntroPhoto] Storage upload failed:', error);
      const statusCode = error.statusCode ? `[HTTP ${error.statusCode}] ` : '';
      throw new Error(`Storage 사진 업로드 실패: ${statusCode}${error.message || error.error || '알 수 없는 오류'}`);
    }

    return objectPath;
  }

  async function removeStorageObjectSafely(path) {
    if (!path || !supabaseClient || !supabaseClient.storage) return;
    const cleanPath = String(path).trim();
    if (!cleanPath || cleanPath.startsWith('data:') || cleanPath.startsWith('http')) return;
    try {
      const cfg = resolveSupabaseConnectionConfig();
      const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
      await supabaseClient.storage.from(bucketName).remove([cleanPath]);
    } catch (err) {
      console.warn('[Storage] Unused object cleanup warning:', cleanPath, err);
    }
  }

  function getIntroPhotoPublicUrl(pathOrUrl) {
    if (!pathOrUrl) return '';
    const clean = String(pathOrUrl).trim();
    if (clean.startsWith('data:') || clean.startsWith('http://') || clean.startsWith('https://')) {
      return clean;
    }
    if (supabaseClient && supabaseClient.storage) {
      const cfg = resolveSupabaseConnectionConfig();
      const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
      const { data } = supabaseClient.storage.from(bucketName).getPublicUrl(clean);
      return (data && data.publicUrl) || '';
    }
    return '';
  }

  async function prepareAndBindIntro() {
    const frameEl = document.getElementById('introPhotoFrame');
    const imgEl = document.getElementById('introPhotoImg');
    const stage = document.getElementById('introCenterStage');
    const rawPath = (state.campaign && state.campaign.introImageUrl) || '';
    const fitMode = (state.campaign && state.campaign.introImageFit === 'contain') ? 'contain' : 'cover';

    // Requirements 4 & 5: Initially keep photo frame hidden and img cleared
    if (imgEl) {
      imgEl.src = '';
      imgEl.classList.remove('is-custom-photo', 'fit-cover', 'fit-contain');
      imgEl.onerror = null;
    }
    if (frameEl) {
      frameEl.hidden = true;
    }

    if (rawPath) {
      const publicUrl = getIntroPhotoPublicUrl(rawPath);
      if (publicUrl && imgEl && frameEl) {
        // Requirement 6: Preload and decode custom image completely before starting intro animation
        let loaded = false;
        try {
          const pre = new Image();
          pre.src = publicUrl;
          await Promise.race([
            pre.decode ? pre.decode().then(() => { loaded = true; }) : new Promise((resolve) => {
              pre.onload = () => { loaded = true; resolve(); };
              pre.onerror = () => { loaded = false; resolve(); };
            }),
            new Promise((resolve) => setTimeout(resolve, 3500))
          ]);
        } catch (e) {
          loaded = false;
        }

        if (loaded) {
          imgEl.src = publicUrl;
          imgEl.classList.add('is-custom-photo', `fit-${fitMode}`);
          frameEl.hidden = false; // Only show frame once photo is loaded
          imgEl.onerror = () => {
            imgEl.onerror = null;
            imgEl.src = '';
            frameEl.hidden = true; // Never show alternative image
          };
        } else {
          // Photo loading failed or timed out: keep frame hidden, do not show any alternative image
          imgEl.src = '';
          frameEl.hidden = true;
        }
      }
    } else {
      // No custom image: keep frame hidden, pure typography celebration animation
      if (frameEl) frameEl.hidden = true;
      if (imgEl) imgEl.src = '';
    }

    // Bind event celebration phrases
    bindIntroEventTitles();

    // Release preparing state so animation starts cleanly
    if (stage) {
      stage.classList.remove('is-preparing');
    }
  }

  function bindIntroEventTitles() {
    const rawType = (state.campaign && state.campaign.eventType) || 'general';
    const cfg = EVENT_TYPE_CONFIG[rawType] || EVENT_TYPE_CONFIG.general;
    const hostName = (state.campaign && state.campaign.hostName) || '주인공';
    const customMsg = ((state.campaign && state.campaign.introMessage) || '').trim();
    const vocative = formatVocativeName(hostName);

    const phrase = (rawType === 'custom' && customMsg) ? customMsg : cfg.introPhrase;

    const introDateTag = document.getElementById('introDateTag');
    const introEnTitle = document.getElementById('introEnTitle');
    const introKrTitle = document.getElementById('introKrTitle');
    const introSubCaption = document.getElementById('introSubCaption');
    const introOrnamentIcon = document.getElementById('introOrnamentIcon');

    if (introDateTag) {
      introDateTag.textContent = `PERSONAL_FUNDING · FOR ${hostName.toUpperCase()}`;
    }
    if (introEnTitle) {
      introEnTitle.textContent = cfg.enTitle;
      introEnTitle.setAttribute('aria-label', cfg.enTitle);
    }
    if (introOrnamentIcon) {
      introOrnamentIcon.textContent = cfg.ornament;
    }
    if (introKrTitle) {
      introKrTitle.innerHTML = `${escapeHtml(vocative)}, ${escapeHtml(phrase)} <span class="intro-heart-beat" aria-hidden="true">${cfg.ornament}</span>`;
    }
    if (introSubCaption) {
      introSubCaption.textContent = cfg.subCaption;
    }
  }

  function bindIntroPhotoAndLabels() {
    prepareAndBindIntro();
  }

  function renderAvatarMediaHtml(avatarUrl, senderName) {
    if (avatarUrl && avatarUrl.trim().length > 0) {
      return `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(senderName || '참여자')} 프로필 사진" loading="lazy" />`;
    }
    return DEFAULT_AVATAR_SVG;
  }

  // =========================================================================
  // 4. METRICS & RENDERING FOR CURRENT CAMPAIGN
  // =========================================================================
  function getGiftMetrics(gift) {
    if (!gift) {
      return { raised: 0, pendingAmount: 0, goal: 1, rawPercent: 0, clampedPercent: 0, remaining: 1, approvedCount: 0, pendingCount: 0, isCompleted: false };
    }
    const targetGiftId = String(gift.id || '').trim();

    // 1 & 4. Strictly filter contributions for THIS individual gift only
    const allForGift = (state.contributions || []).filter((c) => String(c.giftId || '').trim() === targetGiftId);

    // 5. Exclude unapproved contributions: only status === 'approved' counts toward raised amount
    const approvedPledges = allForGift.filter((c) => String(c.status || '').trim() === 'approved');
    const pendingPledges = allForGift.filter((c) => String(c.status || '').trim() !== 'approved');

    const raised = approvedPledges.reduce((sum, c) => sum + Math.max(0, Number(c.amount) || 0), 0);
    const pendingAmount = pendingPledges.reduce((sum, c) => sum + Math.max(0, Number(c.amount) || 0), 0);
    const goal = Math.max(1, Math.round(Number(gift.goalAmount) || 1));

    // 6. Displayed percentage and completion criteria use the EXACT same calculation
    const rawPercent = Math.round((raised / goal) * 100);
    const clampedPercent = Math.min(100, rawPercent);
    const remaining = Math.max(0, goal - raised);

    // 2. Completed when approved raised >= goal OR rawPercent >= 100
    const isCompleted = (raised >= goal) || (rawPercent >= 100);

    return {
      raised,
      pendingAmount,
      goal,
      rawPercent,
      clampedPercent,
      remaining,
      approvedCount: approvedPledges.length,
      pendingCount: pendingPledges.length,
      isCompleted
    };
  }

  function getCampaignMetrics() {
    const totalGoal = state.gifts.reduce((sum, g) => sum + (Number(g.goalAmount) || 0), 0);
    const approvedList = state.contributions.filter((c) => c.status === 'approved');
    const pendingList = state.contributions.filter((c) => c.status !== 'approved');

    const totalRaised = approvedList.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    const totalPendingAmount = pendingList.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

    const rawPercent = totalGoal > 0 ? Math.round((totalRaised / totalGoal) * 100) : 0;
    const clampedPercent = Math.min(100, rawPercent);
    const remaining = Math.max(0, totalGoal - totalRaised);

    let completedGiftsCount = 0;
    state.gifts.forEach((g) => {
      if (getGiftMetrics(g).isCompleted) completedGiftsCount += 1;
    });

    return {
      totalGoal,
      totalRaised,
      totalPendingAmount,
      rawPercent,
      clampedPercent,
      remaining,
      approvedCount: approvedList.length,
      pendingCount: pendingList.length,
      totalCount: state.contributions.length,
      completedGiftsCount,
      totalGiftsCount: state.gifts.length
    };
  }

  function computeDdayInfo(dateStr, hostName) {
    if (!dateStr) return { badge: 'D-DAY', formattedDate: '', isToday: false };
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return { badge: 'D-DAY', formattedDate: dateStr, isToday: false };

    const target = new Date(parts[0], parts[1] - 1, parts[2]);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const diffTime = target.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    const formattedDate = `${parts[0]}. ${String(parts[1]).padStart(2, '0')}. ${String(parts[2]).padStart(2, '0')}`;

    if (diffDays === 0) {
      return { badge: `🎉 HAPPY ${hostName} DAY!`, formattedDate, isToday: true };
    } else if (diffDays > 0) {
      return { badge: `D-${diffDays}`, formattedDate, isToday: false };
    } else {
      return { badge: `D+${Math.abs(diffDays)}`, formattedDate, isToday: false };
    }
  }

  function renderApp() {
    if (!currentCampaignId) {
      updateViewModeUI();
      return;
    }
    renderDynamicHostLabels();
    renderHeaderAndBanners();
    renderHeroSection();
    renderWishlistSection();
    renderParticipantRoster();
    renderGuestbookSection();
    populateGiftFilterOptions();
  }

  // Dynamically bind current campaign's hostName across Intro, Header, Hero, Wishlist, and Modals
  function renderDynamicHostLabels() {
    const hostName = state.campaign.hostName || '주인공';
    const rawType = state.campaign.eventType || 'general';
    const cfg = EVENT_TYPE_CONFIG[rawType] || EVENT_TYPE_CONFIG.general;
    const customMsg = ((state.campaign && state.campaign.introMessage) || '').trim();
    const vocative = formatVocativeName(hostName);
    const withParticle = hasFinalConsonant(hostName) ? '이와의' : '와의';

    const evTitleLabel = (rawType === 'custom' || rawType === 'general') ? '선물' : `${cfg.label} 선물`;
    document.title = `${hostName}님의 ${evTitleLabel} 위시리스트 & 펀딩 | personal_funding`;

    // Intro Event Titles Binding
    bindIntroEventTitles();

    // Header & Footer Brand
    document.getElementById('topBrandTitle').textContent = `FOR ${hostName}`;
    const subLabel = (rawType === 'custom' || rawType === 'general') ? '선물 펀딩' : `${cfg.label} 펀딩`;
    document.getElementById('topBrandSub').textContent = `personal_funding · ${hostName} ${subLabel}`;
    document.getElementById('mobileHomeNavLink').textContent = `${cfg.emoji} ${hostName} 펀딩 홈`;
    document.getElementById('footerBrandTitle').textContent = `personal_funding · FOR ${hostName} — ${hostName}님의 ${evTitleLabel} 위시리스트`;

    // Hero & Wishlist Titles
    document.getElementById('heroExclusivePill').textContent = `FOR ${hostName}`;
    document.getElementById('heroMainPledgeBtnText').textContent = `💝 ${hostName}님에게 선물 펀딩하기`;
    document.getElementById('wishlistEyebrow').textContent = `${hostName}'S WISHLIST`;
    document.getElementById('wishlistSectionTitle').textContent = `${hostName}의 선물 위시리스트`;

    // Pledge Modal Labels
    document.getElementById('pledgeModalEyebrow').textContent = `GIFT FUNDING FOR ${hostName}`;
    document.getElementById('pledgeModalTitle').textContent = cfg.pledgeTitle(hostName);
    document.getElementById('pledgeModalSubtitle').textContent =
      `선물과 금액, 프로필 사진 및 축하 메시지를 입력한 뒤 ${hostName}님에게 송금해 주세요.`;
    document.getElementById('pledgeRelationLabel').textContent = `${hostName}${withParticle} 관계`;
    document.getElementById('pledgeMessageInput').placeholder = cfg.pledgePlaceholder(hostName);
    const remitRecipientNameEl = document.getElementById('remitRecipientName');
    if (remitRecipientNameEl) remitRecipientNameEl.textContent = hostName;
    const guideRecipientNameEl = document.getElementById('guideRecipientName');
    if (guideRecipientNameEl) guideRecipientNameEl.textContent = hostName;
    const bankHolderDisplayEl = document.getElementById('bankHolderDisplay');
    if (bankHolderDisplayEl) bankHolderDisplayEl.textContent = hostName;
    const openKakaoLinkBtnTextEl = document.getElementById('openKakaoLinkBtnText');
    if (openKakaoLinkBtnTextEl) openKakaoLinkBtnTextEl.textContent = `💛 카카오페이로 ${hostName}님에게 송금하기`;
    const openTossLinkBtnTextEl = document.getElementById('openTossLinkBtnText');
    if (openTossLinkBtnTextEl) openTossLinkBtnTextEl.textContent = `💙 토스로 ${hostName}님에게 송금하기`;

    // Update Pledge Modal Purpose Clarification Banner
    const pledgePurposeTag = document.getElementById('pledgePurposeTag');
    const pledgePurposeText = document.getElementById('pledgePurposeText');
    const remitPurposeCallout = document.getElementById('remitPurposeCallout');

    let eventDisplayLabel = '';
    let eventTagEmoji = cfg.emoji;
    if (rawType === 'birthday') {
      eventDisplayLabel = '생일 축하';
    } else if (rawType === 'graduation') {
      eventDisplayLabel = '졸업 축하';
    } else if (rawType === 'wedding') {
      eventDisplayLabel = '결혼 축하';
    } else if (rawType === 'employment') {
      eventDisplayLabel = '입사 축하';
    } else if (rawType === 'admission') {
      eventDisplayLabel = '입학 축하';
    } else if (rawType === 'custom') {
      eventDisplayLabel = customMsg ? `특별한 날 (${customMsg})` : '축하와 응원';
      eventTagEmoji = '✨';
    } else {
      eventDisplayLabel = '소중한 날 선물';
      eventTagEmoji = '🎁';
    }

    if (pledgePurposeTag) {
      pledgePurposeTag.innerHTML = `${eventTagEmoji} ${escapeHtml(eventDisplayLabel)} 펀딩`;
    }
    if (pledgePurposeText) {
      pledgePurposeText.innerHTML = `이 펀딩은 <strong>${escapeHtml(hostName)}</strong>님의 <strong>${escapeHtml(eventDisplayLabel)}</strong> 펀딩입니다. 송금 전 펀딩 목적을 확인해 주세요.`;
    }
    if (remitPurposeCallout) {
      remitPurposeCallout.innerHTML = `💡 <strong>${escapeHtml(hostName)}</strong>님의 <strong>${escapeHtml(eventDisplayLabel)}</strong> 선물을 위한 송금 계좌입니다. 은행 앱에서 받는 분 예금주(<strong>${escapeHtml(hostName)}</strong>)가 맞는지 꼭 확인해 주세요.`;
    }
  }

  function renderHeaderAndBanners() {
    const metrics = getCampaignMetrics();
    document.getElementById('navGiftCount').textContent = state.gifts.length;
    document.getElementById('navMessageCount').textContent = metrics.totalCount;
    document.getElementById('mobileNavGiftCount').textContent = state.gifts.length;
    document.getElementById('mobileNavMessageCount').textContent = metrics.totalCount;

    const navPendingBadge = document.getElementById('navPendingBadge');
    const mobilePendingDot = document.getElementById('mobilePendingDot');
    const pendingAlertBanner = document.getElementById('pendingAlertBanner');

    if (metrics.pendingCount > 0 && currentCampaignId) {
      navPendingBadge.hidden = false;
      navPendingBadge.textContent = `대기 ${metrics.pendingCount}`;
      mobilePendingDot.hidden = !isAdminAuthenticated;
      if (isAdminAuthenticated) {
        pendingAlertBanner.hidden = false;
        document.getElementById('bannerPendingCount').textContent = `${metrics.pendingCount}건`;
        document.getElementById('bannerPendingAmount').textContent = formatKRW(metrics.totalPendingAmount);
      } else {
        pendingAlertBanner.hidden = true;
      }
    } else {
      navPendingBadge.hidden = true;
      mobilePendingDot.hidden = true;
      pendingAlertBanner.hidden = true;
    }

    renderCloudStatusPill();
  }

  function renderHeroSection() {
    const { campaign } = state;
    const dday = computeDdayInfo(campaign.birthdayDate, campaign.hostName);
    const metrics = getCampaignMetrics();

    const ddayBadge = document.getElementById('heroDdayBadge');
    ddayBadge.textContent = dday.badge;
    ddayBadge.classList.toggle('dday-today', dday.isToday);

    document.getElementById('heroDateBadge').textContent = dday.formattedDate;
    const eventCfg = EVENT_TYPE_CONFIG[campaign.eventType] || EVENT_TYPE_CONFIG.general;
    document.getElementById('heroAvatarDisplay').textContent = campaign.emoji || eventCfg.emoji || '🎁';
    document.getElementById('heroSubtitle').textContent = campaign.subtitle;
    document.getElementById('heroTitle').textContent = campaign.headline;
    document.getElementById('heroBio').textContent = campaign.bio;

    document.getElementById('heroTotalRaised').textContent = formatKRW(metrics.totalRaised);
    document.getElementById('heroTotalGoal').textContent = formatKRW(metrics.totalGoal);

    const remainingEl = document.getElementById('heroRemainingText');
    if (metrics.remaining === 0 && metrics.totalGoal > 0) {
      remainingEl.textContent = '🎉 목표 달성!';
    } else {
      remainingEl.textContent = `${formatKRW(metrics.remaining)} 남음`;
    }

    const pendingSubEl = document.getElementById('heroPendingSubText');
    pendingSubEl.textContent = `입금 확인 대기: ${metrics.pendingCount}건 (${formatKRW(metrics.totalPendingAmount)})`;

    const circumference = 251.32;
    const offset = circumference - (metrics.clampedPercent / 100) * circumference;
    const ringCircle = document.getElementById('heroRingCircle');
    ringCircle.style.strokeDashoffset = String(offset);
    ringCircle.style.stroke = metrics.rawPercent >= 100 ? 'var(--pink-deep)' : 'var(--pink-main)';

    document.getElementById('heroPercentText').textContent = `${metrics.rawPercent}%`;
    document.getElementById('heroLinearBar').style.width = `${metrics.clampedPercent}%`;

    document.getElementById('kpiBackerCount').textContent = `${metrics.approvedCount}명`;
    document.getElementById('kpiCompletedGifts').textContent = `${metrics.completedGiftsCount} / ${metrics.totalGiftsCount}개`;
    document.getElementById('kpiPendingCount').textContent = `${metrics.pendingCount}건`;

    const avatarStack = document.getElementById('supportersAvatarStack');
    const summaryText = document.getElementById('supportersSummaryText');
    const approvedList = state.contributions.filter((c) => c.status === 'approved');
    const recentApproved = approvedList.slice(-4).reverse();

    if (approvedList.length === 0) {
      avatarStack.innerHTML = '';
      if (metrics.pendingCount > 0) {
        summaryText.innerHTML = `현재 <strong>${metrics.pendingCount}건</strong>의 송금이 입금 확인을 기다리고 있어요!`;
      } else {
        const cheerCopy = (campaign.eventType === 'custom' || campaign.eventType === 'general')
          ? '축하와 응원 마음'
          : `${eventCfg.label} 축하 마음`;
        summaryText.textContent = `${campaign.hostName}님에게 첫 번째로 ${cheerCopy}을 전해보세요!`;
      }
    } else {
      avatarStack.innerHTML = recentApproved
        .map((c) => {
          return `<span class="supporter-mini-avatar" title="${escapeHtml(c.senderName)}">${renderAvatarMediaHtml(c.avatarUrl, c.senderName)}</span>`;
        })
        .join('');
      const latest = recentApproved[0];
      if (approvedList.length === 1) {
        const giftKindLabel = (campaign.eventType === 'custom' || campaign.eventType === 'general')
          ? '선물 펀딩'
          : `${eventCfg.label} 펀딩`;
        summaryText.innerHTML = `<strong>${escapeHtml(latest.senderName)}</strong>님의 ${giftKindLabel} 입금이 확인되었어요!`;
      } else {
        summaryText.innerHTML = `최근 <strong>${escapeHtml(latest.senderName)}</strong>님 외 ${approvedList.length - 1}명이 마음을 모았어요!`;
      }
    }
  }

  function renderWishlistSection() {
    const grid = document.getElementById('wishlistGrid');

    let enriched = state.gifts.map((gift) => ({
      gift,
      metrics: getGiftMetrics(gift)
    }));

    if (currentGiftFilter === 'funding') {
      enriched = enriched.filter((item) => !item.metrics.isCompleted);
    } else if (currentGiftFilter === 'completed') {
      enriched = enriched.filter((item) => item.metrics.isCompleted);
    }

    enriched.sort((a, b) => {
      if (currentGiftSort === 'priority') return (a.gift.priority || 2) - (b.gift.priority || 2);
      if (currentGiftSort === 'progress-desc') return b.metrics.rawPercent - a.metrics.rawPercent;
      if (currentGiftSort === 'remaining-asc') return a.metrics.remaining - b.metrics.remaining;
      if (currentGiftSort === 'price-asc') return a.metrics.goal - b.metrics.goal;
      return 0;
    });

    if (enriched.length === 0) {
      grid.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-state-icon">🎁</div>
          <p>조건에 해당하는 선물이 없습니다.</p>
        </div>
      `;
      return;
    }

    const priorityLabels = {
      1: '1순위 위시',
      2: '2순위 위시',
      3: '3순위 위시'
    };

    grid.innerHTML = enriched
      .map(({ gift, metrics }) => {
        const hasPhoto = Boolean(gift.imageUrl && gift.imageUrl.trim().length > 0);
        const fitClass = gift.imageFit === 'contain' ? 'fit-contain' : '';
        const visualContentHtml = hasPhoto
          ? `<img class="gift-photo-img ${fitClass}" src="${escapeHtml(gift.imageUrl)}" alt="${escapeHtml(gift.title)}" loading="lazy" />`
          : (CATEGORY_SVGS[gift.category] || CATEGORY_SVGS.cake);

        const pLabel = priorityLabels[gift.priority] || '위시 선물';

        let statusBadge = '';
        if (metrics.isCompleted) {
          statusBadge = `<span class="status-pill completed">100% 달성 완료</span>`;
        } else if (metrics.pendingCount > 0) {
          statusBadge = `<span class="status-pill in-progress">승인 ${metrics.approvedCount} · 대기 ${metrics.pendingCount}</span>`;
        } else {
          statusBadge = `<span class="status-pill in-progress">${metrics.approvedCount}명 참여</span>`;
        }

        const remainingCopy = metrics.isCompleted
          ? `목표 금액 달성 완료!`
          : `남은 금액 ${formatKRW(metrics.remaining)}`;

        const pendingMetaCopy = metrics.pendingCount > 0
          ? `대기 ${metrics.pendingCount}건(${formatKRW(metrics.pendingAmount)})`
          : `승인 ${metrics.approvedCount}건`;

        const ctaLabel = metrics.isCompleted
          ? `🎉 달성 완료 · 추가 펀딩하기`
          : `💝 이 선물 펀딩 참여하기`;

        const validProductUrl = getValidHttpUrl(gift.productUrl);
        const productLinkHtml = validProductUrl
          ? `
            <a href="${escapeHtml(validProductUrl)}" target="_blank" rel="noopener noreferrer" class="btn-product-link" aria-label="${escapeHtml(gift.title)} 상품 보러가기">
              <span>🛍️ 상품 보러가기</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          `
          : '';

        const hostActionsHtml = isAdminAuthenticated
          ? `
            <div class="gift-host-actions">
              <button type="button" class="btn-card-host" data-action="edit-gift" data-gift-id="${escapeHtml(gift.id)}">✏️ 사진·내용 수정</button>
              <button type="button" class="btn-card-host delete" data-action="delete-gift" data-gift-id="${escapeHtml(gift.id)}">삭제</button>
            </div>
          `
          : '';

        const isExpanded = expandedGiftDescIds.has(gift.id);
        const hasDesc = Boolean(gift.description && gift.description.trim());
        const descHtml = hasDesc
          ? `
            <div class="gift-desc-wrap">
              <p class="gift-desc ${isExpanded ? 'is-expanded' : ''}" id="gift-desc-${escapeHtml(gift.id)}">${escapeHtml(gift.description)}</p>
              <button type="button" class="btn-gift-desc-toggle" data-action="toggle-desc" data-gift-id="${escapeHtml(gift.id)}" ${isExpanded ? 'aria-expanded="true"' : 'aria-expanded="false"'} hidden>
                <span class="desc-toggle-text">${isExpanded ? '접기' : '전체보기'}</span>
                <span class="desc-toggle-arrow">${isExpanded ? '▴' : '▾'}</span>
              </button>
            </div>
          `
          : '';

        return `
          <article class="gift-card ${metrics.isCompleted ? 'is-completed' : ''}" data-gift-id="${escapeHtml(gift.id)}">
            <div class="gift-visual visual-theme-${escapeHtml(gift.category || 'cake')}">
              <div class="gift-badges-top">
                <span class="priority-pill p-${gift.priority}">${pLabel}</span>
                ${statusBadge}
              </div>
              ${visualContentHtml}
              ${hostActionsHtml}
            </div>

            <div class="gift-body">
              <div>
                <div class="gift-brand">${escapeHtml(gift.brand || 'GIFT WISHLIST')}</div>
                <h3 class="gift-title">${escapeHtml(gift.title)}</h3>
                ${descHtml}
              </div>

              <div class="gift-funding-box">
                <div class="gift-price-row gift-price-nums">
                  <div>
                    <span class="gift-raised-amount">${formatKRW(metrics.raised)}</span>
                    <span class="gift-goal-amount">/ 목표 ${formatKRW(metrics.goal)}</span>
                  </div>
                  <span class="gift-percent-badge">${metrics.rawPercent}%</span>
                </div>

                <div class="gift-bar-track">
                  <div class="gift-bar-fill" style="width: ${metrics.clampedPercent}%"></div>
                </div>

                <div class="gift-meta-foot gift-price-nums">
                  <span>${remainingCopy}</span>
                  <span>${pendingMetaCopy}</span>
                </div>
              </div>

              <div class="gift-card-footer">
                ${productLinkHtml}
                <button type="button" class="btn-pledge-card" data-action="open-pledge" data-gift-id="${escapeHtml(gift.id)}">
                  ${ctaLabel}
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    updateGiftDescToggles();
  }

  function updateGiftDescToggles() {
    const cards = document.querySelectorAll('#wishlistGrid .gift-card');
    cards.forEach((card) => {
      const descEl = card.querySelector('.gift-desc');
      const toggleBtn = card.querySelector('.btn-gift-desc-toggle');
      if (!descEl || !toggleBtn) return;

      const isExpanded = descEl.classList.contains('is-expanded');
      if (isExpanded) {
        descEl.classList.remove('is-expanded');
      }

      // Check if text exceeds 3 clamped lines
      const isOverflowing = descEl.scrollHeight > descEl.clientHeight + 1;

      if (isExpanded) {
        descEl.classList.add('is-expanded');
      }

      if (isOverflowing) {
        toggleBtn.hidden = false;
        const textSpan = toggleBtn.querySelector('.desc-toggle-text');
        const arrowSpan = toggleBtn.querySelector('.desc-toggle-arrow');
        if (textSpan) textSpan.textContent = isExpanded ? '접기' : '전체보기';
        if (arrowSpan) arrowSpan.textContent = isExpanded ? '▴' : '▾';
        toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      } else {
        toggleBtn.hidden = true;
      }
    });
  }

  function renderParticipantRoster() {
    const rosterCard = document.getElementById('participantRosterCard');
    const rosterList = document.getElementById('participantRosterList');
    const rosterCountText = document.getElementById('rosterCountText');

    if (state.contributions.length === 0) {
      rosterCard.hidden = true;
      rosterList.innerHTML = '';
      return;
    }

    rosterCard.hidden = false;
    const approvedCount = state.contributions.filter((c) => c.status === 'approved').length;
    const pendingCount = state.contributions.length - approvedCount;
    rosterCountText.textContent = pendingCount > 0
      ? `총 ${state.contributions.length}명 (승인 ${approvedCount} · 대기 ${pendingCount})`
      : `총 ${state.contributions.length}명 참여`;

    const recentFirst = [...state.contributions].reverse();
    rosterList.innerHTML = recentFirst
      .map((item) => {
        const isApproved = item.status === 'approved';
        const amountLabel = formatKRW(item.amount);
        return `
          <div class="roster-member-chip" title="${escapeHtml(item.senderName)} (${amountLabel})">
            <div class="roster-avatar-circle ${isApproved ? '' : 'is-pending'}">
              <div class="roster-avatar-inner">
                ${renderAvatarMediaHtml(item.avatarUrl, item.senderName)}
              </div>
            </div>
            <span class="roster-member-name">${escapeHtml(item.senderName)}</span>
            <span class="roster-member-meta">${amountLabel}</span>
          </div>
        `;
      })
      .join('');
  }

  function populateGiftFilterOptions() {
    const filterSelect = document.getElementById('messageGiftFilter');
    const prevValue = filterSelect.value;

    const optionsHtml = [
      `<option value="all">모든 선물 내역 (${state.contributions.length})</option>`,
      ...state.gifts.map((g) => {
        const count = state.contributions.filter((c) => c.giftId === g.id).length;
        return `<option value="${escapeHtml(g.id)}">${CATEGORY_EMOJI[g.category] || '🎁'} ${escapeHtml(g.title)} (${count})</option>`;
      })
    ].join('');

    filterSelect.innerHTML = optionsHtml;
    if (state.gifts.some((g) => g.id === prevValue) || prevValue === 'all') {
      filterSelect.value = prevValue;
    }
  }

  function renderGuestbookSection() {
    const grid = document.getElementById('blessingGrid');
    const giftMap = new Map(state.gifts.map((g) => [g.id, g]));

    const repliesByContribution = new Map();
    (state.replies || []).forEach((r) => {
      const list = repliesByContribution.get(r.contributionId) || [];
      list.push(r);
      repliesByContribution.set(r.contributionId, list);
    });

    let items = [...state.contributions].reverse();

    if (currentStatusFilter === 'pending') {
      items = items.filter((c) => c.status !== 'approved');
    } else if (currentStatusFilter === 'approved') {
      items = items.filter((c) => c.status === 'approved');
    }

    if (currentMessageGiftFilter !== 'all') {
      items = items.filter((c) => c.giftId === currentMessageGiftFilter);
    }

    if (currentMessageSearch.trim() !== '') {
      const q = currentMessageSearch.trim().toLowerCase();
      items = items.filter(
        (c) =>
          (c.senderName || '').toLowerCase().includes(q) ||
          (c.message || '').toLowerCase().includes(q) ||
          (c.relation || '').toLowerCase().includes(q)
      );
    }

    if (items.length === 0) {
      grid.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-state-icon">💌</div>
          <p>아직 등록된 펀딩 참여 내역이 없습니다.<br/>${escapeHtml(state.campaign.hostName)}님에게 첫 번째 선물 펀딩과 축하 메시지를 남겨보세요!</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = items
      .map((item) => {
        const isApproved = item.status === 'approved';
        const targetGift = giftMap.get(item.giftId);
        const evGiftWord = (state.campaign.eventType === 'birthday') ? '생일 선물' : '선물';
        const giftLabel = targetGift
          ? `${CATEGORY_EMOJI[targetGift.category] || '🎁'} ${targetGift.title}`
          : `🎁 ${state.campaign.hostName}님의 ${evGiftWord}`;
        const themeClass = `theme-${item.theme || 'warm-cream'}`;

        let depositStatusRowHtml = '';
        if (isApproved) {
          depositStatusRowHtml = `
            <div class="deposit-status-row approved">
              <span>✅ 입금 확인 완료 (달성률 반영됨)</span>
              ${
                isAdminAuthenticated
                  ? `<button type="button" class="btn-unapprove-deposit" data-action="unapprove-pledge" data-pledge-id="${escapeHtml(item.id)}">승인 취소</button>`
                  : ''
              }
            </div>
          `;
        } else {
          depositStatusRowHtml = `
            <div class="deposit-status-row pending">
              <span>⏳ 입금 확인 대기 (펀딩 주인 확인 후 달성률 반영)</span>
              ${
                isAdminAuthenticated
                  ? `<div class="admin-deposit-actions">
                      <button type="button" class="btn-approve-deposit" data-action="approve-pledge" data-pledge-id="${escapeHtml(item.id)}" title="실제 입금을 확인하여 달성률에 반영합니다">✅ 입금 확인 승인</button>
                      <button type="button" class="btn-reject-deposit" data-action="delete-pledge" data-pledge-id="${escapeHtml(item.id)}" title="미입금 또는 잘못된 신청을 삭제합니다">❌ 미입금 삭제/거절</button>
                    </div>`
                  : ''
              }
            </div>
          `;
        }

        const amountTagHtml = isApproved
          ? `<span class="pledge-amount-tag">+ ${formatKRW(item.amount)}</span>`
          : `<span class="pledge-amount-tag pending-tag">대기 ${formatKRW(item.amount)}</span>`;

        const adminDeleteBtnHtml = isAdminAuthenticated
          ? `<button type="button" class="btn-delete-msg" data-action="delete-pledge" data-pledge-id="${escapeHtml(item.id)}">삭제</button>`
          : '';

        const itemReplies = repliesByContribution.get(item.id) || [];
        const isThreadOpen = openReplyThreadIds.has(item.id);
        const isFormOpen = openReplyFormIds.has(item.id);
        const replyCount = itemReplies.length;

        const repliesListHtml = itemReplies
          .map((r) => `
            <div class="reply-item ${r.isHost ? 'is-host' : ''}" data-reply-id="${escapeHtml(r.id)}">
              <span class="reply-item-branch" aria-hidden="true">↳</span>
              <div class="reply-bubble">
                <div class="reply-meta-row">
                  <div class="reply-author-info">
                    <strong class="reply-author-name">${escapeHtml(r.authorName)}</strong>
                    ${r.isHost ? '<span class="reply-host-badge">👑 펀딩 주인</span>' : ''}
                  </div>
                  <span class="reply-time">${escapeHtml(r.createdAtLabel || formatIsoTimestamp(r.createdAt))}</span>
                </div>
                <p class="reply-text">${escapeHtml(r.content)}</p>
                <div class="reply-actions-row">
                  <button type="button" class="btn-report-reply" data-action="report-reply" data-reply-id="${escapeHtml(r.id)}">🚨 신고</button>
                  ${
                    isAdminAuthenticated
                      ? `<button type="button" class="btn-delete-reply" data-action="delete-reply" data-reply-id="${escapeHtml(r.id)}">삭제</button>`
                      : ''
                  }
                </div>
              </div>
            </div>
          `)
          .join('');

        return `
          <article class="blessing-card ${escapeHtml(themeClass)} ${isApproved ? '' : 'is-pending-card'}" data-pledge-id="${escapeHtml(item.id)}">
            <div>
              ${depositStatusRowHtml}

              <div class="blessing-top">
                <div class="blessing-sender-wrap">
                  <div class="blessing-avatar" title="${escapeHtml(item.senderName)} 프로필">
                    ${renderAvatarMediaHtml(item.avatarUrl, item.senderName)}
                  </div>
                  <div class="blessing-sender-info">
                    <div class="blessing-sender-name">
                      ${escapeHtml(item.senderName)}
                      <span class="relation-chip">${escapeHtml(item.relation || '친구')}</span>
                    </div>
                    <div class="blessing-selected-gift-pill" title="선택한 선물: ${escapeHtml(giftLabel)}">
                      ${escapeHtml(giftLabel)}
                    </div>
                    <div class="blessing-time">${escapeHtml(item.createdAt || '방금 전')}</div>
                  </div>
                </div>
                <div class="pledge-amount-col">
                  ${amountTagHtml}
                </div>
              </div>

              <p class="blessing-message">${escapeHtml(item.message)}</p>
            </div>

            <div class="blessing-footer">
              <div class="blessing-footer-left">
                <button
                  type="button"
                  class="btn-reply-toggle ${isThreadOpen ? 'active' : ''}"
                  data-action="toggle-replies"
                  data-pledge-id="${escapeHtml(item.id)}"
                  title="답글 보기/접기"
                >
                  💬 답글 ${replyCount > 0 ? `<span class="reply-count-badge">${replyCount}</span>` : ''}
                  <span class="reply-toggle-arrow">${isThreadOpen ? '▴' : '▾'}</span>
                </button>

                <button
                  type="button"
                  class="btn-open-reply-form"
                  data-action="open-reply-form"
                  data-pledge-id="${escapeHtml(item.id)}"
                  title="답글 달기"
                >
                  ✍️ 답글 달기
                </button>

                <button
                  type="button"
                  class="btn-manage-avatar"
                  data-action="manage-avatar"
                  data-pledge-id="${escapeHtml(item.id)}"
                  title="비밀번호 확인 후 내 프로필 사진 변경 또는 삭제"
                >
                  📷 사진 변경·삭제
                </button>
              </div>

              <div class="blessing-actions">
                <button
                  type="button"
                  class="btn-cheer ${item.cheeredByMe ? 'cheered' : ''}"
                  data-action="cheer-pledge"
                  data-pledge-id="${escapeHtml(item.id)}"
                >
                  ❤️ <span>${Number(item.cheers) || 0}</span>
                </button>
                ${adminDeleteBtnHtml}
              </div>
            </div>

            <!-- Replies Thread Section (1-Level Indented) -->
            <div class="blessing-replies-wrap ${isThreadOpen ? 'is-open' : ''}" id="repliesWrap-${escapeHtml(item.id)}" ${isThreadOpen ? '' : 'hidden'}>
              <!-- Reply Input Form Box -->
              <div class="reply-form-box" id="replyFormBox-${escapeHtml(item.id)}" ${isFormOpen ? '' : 'hidden'}>
                <form class="reply-submit-form" data-pledge-id="${escapeHtml(item.id)}" novalidate>
                  <div class="reply-form-header">
                    <input
                      type="text"
                      class="form-input reply-author-input"
                      placeholder="${isAdminAuthenticated ? escapeHtml(state.campaign.hostName) + ' (주인)' : '닉네임 (최대 20자)'}"
                      value="${isAdminAuthenticated ? escapeHtml(state.campaign.hostName) : ''}"
                      maxlength="30"
                      required
                    />
                    ${isAdminAuthenticated ? '<span class="host-verified-pill">👑 펀딩 주인</span>' : ''}
                  </div>
                  <div class="reply-form-body">
                    <textarea
                      class="form-textarea reply-content-input"
                      placeholder="${isAdminAuthenticated ? '응원해 주신 분께 따뜻한 감사 답글을 남겨보세요 ♡' : '응원 메시지에 따뜻한 답글을 남겨보세요 (최대 300자)'}"
                      maxlength="300"
                      rows="2"
                      required
                    ></textarea>
                  </div>
                  <div class="reply-form-actions">
                    <span class="reply-char-hint">0 / 300자</span>
                    <div style="display: flex; gap: 6px;">
                      <button type="button" class="btn-subtle btn-xs btn-reply-cancel" data-action="cancel-reply" data-pledge-id="${escapeHtml(item.id)}">취소</button>
                      <button type="submit" class="btn-primary btn-xs btn-reply-submit">답글 등록</button>
                    </div>
                  </div>
                </form>
              </div>

              <!-- Replies List -->
              <div class="replies-list" id="repliesList-${escapeHtml(item.id)}">
                ${repliesListHtml || (isFormOpen ? '' : '<div class="no-replies-hint">등록된 답글이 없습니다. [✍️ 답글 달기]를 눌러 첫 답글을 남겨보세요!</div>')}
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // =========================================================================
  // 5. PLEDGE / REMITTANCE MODAL (Friend Participation -> Pending)
  // =========================================================================
  function updatePledgeAvatarPreviewUI(srcUrl) {
    const previewImg = document.getElementById('pledgeAvatarPreviewImg');
    const defaultIcon = document.getElementById('pledgeAvatarDefaultIcon');
    const removeBtn = document.getElementById('removePledgeAvatarBtn');
    const uploadLabel = document.getElementById('pledgeAvatarUploadLabel');
    const consentBox = document.getElementById('pledgePhotoConsentBox');
    const storageHint = document.getElementById('pledgeAvatarStorageHint');

    if (srcUrl && srcUrl.trim() !== '') {
      previewImg.src = srcUrl;
      previewImg.hidden = false;
      defaultIcon.hidden = true;
      removeBtn.hidden = false;
      uploadLabel.childNodes[0].nodeValue = '📷 사진 변경 ';
      consentBox.hidden = false;

      if (isSupabaseConfigured()) {
        storageHint.innerHTML =
          '☁️ <strong>Supabase Storage 연결됨:</strong> 압축된 프로필 사진이 클라우드에 저장되어 모든 방문자에게 표시됩니다.';
      } else {
        storageHint.innerHTML =
          '💡 <strong>로컬 미리보기 상태:</strong> 현재 선택한 사진은 이 브라우저에 저장됩니다.';
      }
    } else {
      previewImg.src = '';
      previewImg.hidden = true;
      defaultIcon.hidden = false;
      removeBtn.hidden = true;
      uploadLabel.childNodes[0].nodeValue = '📷 프로필 사진 추가 ';
      consentBox.hidden = true;
      document.getElementById('pledgePhotoConsentCheck').checked = false;
      storageHint.textContent = 'JPG, PNG, WEBP 지원 (미등록 시 기본 인디핑크 프로필 아이콘이 표시됩니다)';
    }
  }

  function resetPledgeAvatarState() {
    pledgeAvatarDataUrl = '';
    pledgeAvatarBlob = null;
    pledgeAvatarMime = 'image/webp';
    const fileInput = document.getElementById('pledgeAvatarFileInput');
    if (fileInput) fileInput.value = '';
    updatePledgeAvatarPreviewUI('');
  }

  function openPledgeModal(preselectedGiftId) {
    if (state.gifts.length === 0) {
      showToast('현재 등록된 위시리스트 선물이 없습니다.');
      return;
    }

    const backdrop = document.getElementById('pledgeModalBackdrop');
    const formView = document.getElementById('pledgeFormView');
    const receiptView = document.getElementById('pledgeReceiptView');
    const giftSelect = document.getElementById('pledgeGiftSelect');
    const errorEl = document.getElementById('pledgeErrorMsg');

    formView.hidden = false;
    receiptView.hidden = true;
    errorEl.hidden = true;

    resetPledgeAvatarState();
    document.getElementById('pledgeSelfPinInput').value = '';

    giftSelect.innerHTML = state.gifts
      .map((g) => {
        const m = getGiftMetrics(g);
        const statusText = m.isCompleted ? '달성완료' : `승인 ${m.rawPercent}% (목표 ${formatKRW(m.goal)})`;
        return `<option value="${escapeHtml(g.id)}">${CATEGORY_EMOJI[g.category] || '🎁'} ${escapeHtml(g.title)} — ${statusText}</option>`;
      })
      .join('');

    if (preselectedGiftId && state.gifts.some((g) => g.id === preselectedGiftId)) {
      giftSelect.value = preselectedGiftId;
    } else {
      const incomplete = state.gifts.find((g) => !getGiftMetrics(g).isCompleted);
      giftSelect.value = incomplete ? incomplete.id : state.gifts[0].id;
    }

    updateRemitBoxState();
    updateSelectedGiftPreview();

    const defaultStart = Math.min(30000, currentGiftMaxTarget);
    updatePledgeAmountUI(defaultStart);

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function updateRemitBoxState() {
    const { campaign } = state;
    const validKakaoUrl = getValidHttpUrl(campaign.kakaoRemitUrl);
    const validTossUrl = getValidHttpUrl(campaign.tossRemitUrl);
    const bankAccount = (campaign.bankAccount || '').trim();
    const bankName = (campaign.bankName || '').trim();
    const hasBank = bankAccount.length > 0;

    const configuredArea = document.getElementById('remitConfiguredArea');
    const missingArea = document.getElementById('tossLinkMissingArea');
    const registerBtn = document.getElementById('goRegisterTossLinkBtn');

    const optKakao = document.getElementById('optRemitKakaoLabel');
    const optToss = document.getElementById('optRemitTossLabel');
    const optBank = document.getElementById('optRemitBankLabel');

    if (registerBtn) {
      registerBtn.hidden = !isAdminAuthenticated;
    }

    if (validKakaoUrl || validTossUrl || hasBank) {
      configuredArea.hidden = false;
      missingArea.hidden = true;

      if (optKakao) optKakao.hidden = !validKakaoUrl;
      if (optToss) optToss.hidden = !validTossUrl;
      if (optBank) {
        optBank.hidden = !hasBank;
        const bankSub = document.getElementById('optRemitBankSubtitle');
        if (bankSub && hasBank) {
          bankSub.textContent = bankName ? `${bankName} 계좌이체` : '은행 계좌번호 복사';
        }
      }

      // Check available options
      const availableMethods = [];
      if (validKakaoUrl) availableMethods.push('kakao');
      if (validTossUrl) availableMethods.push('toss');
      if (hasBank) availableMethods.push('bank');

      if (!availableMethods.includes(currentSelectedRemitMethod)) {
        currentSelectedRemitMethod = availableMethods[0] || 'bank';
      }

      const radio = document.querySelector(`input[name="selectedRemitMethod"][value="${currentSelectedRemitMethod}"]`);
      if (radio) radio.checked = true;

      updateSelectedRemitMethodPreview();
    } else {
      configuredArea.hidden = true;
      missingArea.hidden = false;
      const previewBox = document.getElementById('selectedMethodPreviewBox');
      if (previewBox) previewBox.innerHTML = '';
      const btnText = document.getElementById('submitPledgeBtnText');
      if (btnText) btnText.textContent = '💌 응원 메시지 남기기';
    }
  }

  function updateSelectedRemitMethodPreview() {
    const { campaign } = state;
    const previewBox = document.getElementById('selectedMethodPreviewBox');
    if (!previewBox) return;

    const bankAccount = (campaign.bankAccount || '').trim();
    const bankName = (campaign.bankName || '').trim();
    const cleanAmount = Math.max(0, Math.round(Number(document.getElementById('pledgeAmountInput')?.value) || 0));
    const btnTextEl = document.getElementById('submitPledgeBtnText');

    let previewHtml = '';
    let submitLabel = '💌 응원 메시지 남기고 송금하기';

    if (currentSelectedRemitMethod === 'kakao') {
      submitLabel = `💛 카카오페이로 ${cleanAmount > 0 ? formatKRW(cleanAmount) + ' ' : ''}송금하기`;
      previewHtml = `
        <div class="remit-method-guide-banner">
          💛 <strong>카카오페이 송금:</strong> 아래 버튼을 누르면 <strong>응원 메시지가 먼저 안전하게 저장</strong>된 후 카카오페이 송금 앱(화면)으로 바로 연결됩니다.
        </div>
      `;
    } else if (currentSelectedRemitMethod === 'toss') {
      submitLabel = `💙 토스로 ${cleanAmount > 0 ? formatKRW(cleanAmount) + ' ' : ''}송금하기`;
      previewHtml = `
        <div class="remit-method-guide-banner">
          💙 <strong>토스 송금:</strong> 아래 버튼을 누르면 <strong>응원 메시지가 먼저 안전하게 저장</strong>된 후 토스 송금 앱(화면)으로 바로 연결됩니다.
        </div>
      `;
    } else if (currentSelectedRemitMethod === 'bank') {
      submitLabel = `🏦 계좌 확인하고 ${cleanAmount > 0 ? formatKRW(cleanAmount) + ' ' : ''}송금하기`;
      const fullBankLabel = bankName ? `${bankName} ${bankAccount}` : bankAccount;
      previewHtml = `
        <div class="bank-account-card">
          <div class="bank-account-info">
            <span class="bank-badge">계좌송금</span>
            <div class="bank-text-wrap">
              <strong>${escapeHtml(fullBankLabel)}</strong>
              <span class="bank-holder-text">예금주: <strong>${escapeHtml(campaign.hostName || '주인공')}</strong></span>
            </div>
          </div>
          <button type="button" class="btn-copy-bank" id="copyBankPreviewBtn" data-bank-text="${escapeHtml(fullBankLabel)}">
            📋 계좌 복사
          </button>
        </div>
        <div class="remit-method-guide-banner" style="margin-top: 6px;">
          🏦 <strong>계좌이체:</strong> 아래 버튼을 누르면 <strong>응원 메시지가 먼저 등록</strong>되고, 바로 송금하실 수 있도록 계좌번호와 금액 복사 화면이 크게 안내됩니다.
        </div>
      `;
    }

    previewBox.innerHTML = previewHtml;
    if (btnTextEl && !isSubmittingPledge) {
      btnTextEl.textContent = submitLabel;
    }

    const copyBtn = document.getElementById('copyBankPreviewBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleCopyBankAccount();
      });
    }
  }

  function renderReceiptRemitAction(method, amount) {
    const box = document.getElementById('receiptRemitActionBox');
    if (!box) return;

    const { campaign } = state;
    const validKakaoUrl = getValidHttpUrl(campaign.kakaoRemitUrl);
    const validTossUrl = getValidHttpUrl(campaign.tossRemitUrl);
    const bankAccount = (campaign.bankAccount || '').trim();
    const bankName = (campaign.bankName || '').trim();
    const hasBank = bankAccount.length > 0;
    const fullBankLabel = bankName ? `${bankName} ${bankAccount}` : bankAccount;
    const cleanAmountStr = formatKRW(amount);

    let html = '';

    if (method === 'kakao' && validKakaoUrl) {
      html = `
        <div class="receipt-action-title">💛 카카오페이로 ${cleanAmountStr} 송금하기</div>
        <p class="receipt-action-desc">
          아래 노란색 버튼을 눌러 카카오페이 앱(또는 모바일 웹)에서 <strong>${escapeHtml(campaign.hostName)}</strong>님에게 송금해 주세요.
        </p>
        <a href="${escapeHtml(validKakaoUrl)}" target="_blank" rel="noopener noreferrer" class="btn-kakao-open remit-action-hero-btn" id="receiptKakaoOpenBtn">
          💛 카카오페이 송금 앱 열기
        </a>
        <p class="remit-app-help-text">💡 송금 앱이 자동으로 열리지 않았다면 위 노란색 버튼을 한 번 더 눌러주세요.</p>
        ${
          hasBank
            ? `<div class="receipt-alt-bank-box">
                <span>또는 계좌번호로 직접 송금: <strong>${escapeHtml(fullBankLabel)} (예금주: ${escapeHtml(campaign.hostName)})</strong></span>
                <button type="button" class="btn-copy-bank btn-xs" id="receiptAltCopyBankBtn">📋 계좌 복사</button>
              </div>`
            : ''
        }
      `;
    } else if (method === 'toss' && validTossUrl) {
      html = `
        <div class="receipt-action-title">💙 토스(Toss)로 ${cleanAmountStr} 송금하기</div>
        <p class="receipt-action-desc">
          아래 파란색 버튼을 눌러 토스 앱에서 <strong>${escapeHtml(campaign.hostName)}</strong>님에게 송금해 주세요.
        </p>
        <a href="${escapeHtml(validTossUrl)}" target="_blank" rel="noopener noreferrer" class="btn-toss-open remit-action-hero-btn" id="receiptTossOpenBtn">
          💙 토스 송금 앱 열기
        </a>
        <p class="remit-app-help-text">💡 송금 앱이 자동으로 열리지 않았다면 위 파란색 버튼을 한 번 더 눌러주세요.</p>
        ${
          hasBank
            ? `<div class="receipt-alt-bank-box">
                <span>또는 계좌번호로 직접 송금: <strong>${escapeHtml(fullBankLabel)} (예금주: ${escapeHtml(campaign.hostName)})</strong></span>
                <button type="button" class="btn-copy-bank btn-xs" id="receiptAltCopyBankBtn">📋 계좌 복사</button>
              </div>`
            : ''
        }
      `;
    } else {
      // Bank transfer
      html = `
        <div class="receipt-bank-highlight-card">
          <span class="rb-badge">🏦 계좌이체 (무통장입금) 안내</span>
          <div class="rb-account-row">
            <span style="font-size: 0.95rem; color: var(--text-secondary);">${escapeHtml(bankName || '입금계좌')}:</span>
            <strong style="color: var(--pink-deep); font-size: 1.25rem; letter-spacing: 0.5px;">${escapeHtml(bankAccount || '계좌 미등록')}</strong>
          </div>
          <div class="rb-holder-row">
            예금주: <strong>${escapeHtml(campaign.hostName || '주인공')}</strong> &nbsp;·&nbsp; 보내실 금액: <strong style="color: var(--pink-deep);">${cleanAmountStr}</strong>
          </div>
          <div class="rb-actions-row">
            <button type="button" class="btn-primary btn-copy-bank-large" id="receiptCopyBankMainBtn">
              📋 계좌번호 복사하기
            </button>
            <button type="button" class="btn-secondary btn-copy-amount-large" id="receiptCopyAmountMainBtn">
              📋 금액(${formatNumberKo(amount)}원) 복사
            </button>
          </div>
          <p class="remit-app-help-text" style="margin-top: 10px;">
            💡 은행 앱(카카오뱅크, 국민, 신한, 토스 등)에서 복사한 계좌번호로 송금해 주시면 펀딩 주인이 확인 후 승인합니다.
          </p>
        </div>
      `;
    }

    box.innerHTML = html;

    const altCopy = document.getElementById('receiptAltCopyBankBtn');
    if (altCopy) {
      altCopy.addEventListener('click', () => handleCopyBankAccount());
    }
    const mainCopy = document.getElementById('receiptCopyBankMainBtn');
    if (mainCopy) {
      mainCopy.addEventListener('click', () => handleCopyBankAccount());
    }
    const amountCopy = document.getElementById('receiptCopyAmountMainBtn');
    if (amountCopy) {
      amountCopy.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(amount)).then(() => {
            showToast(`금액(${formatNumberKo(amount)}원)이 복사되었습니다.`);
          });
        }
      });
    }
  }

  function closePledgeModal() {
    const backdrop = document.getElementById('pledgeModalBackdrop');
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function updateSelectedGiftPreview() {
    const giftId = document.getElementById('pledgeGiftSelect').value;
    const gift = state.gifts.find((g) => g.id === giftId);
    if (!gift) return;

    const metrics = getGiftMetrics(gift);
    document.getElementById('sgpIcon').textContent = CATEGORY_EMOJI[gift.category] || '🎁';
    document.getElementById('sgpTitle').textContent = gift.title;
    document.getElementById('sgpStatusText').textContent =
      `현재 승인액 ${formatKRW(metrics.raised)} / 목표 ${formatKRW(metrics.goal)} (${metrics.isCompleted ? '목표 달성!' : '남은 금액 ' + formatKRW(metrics.remaining)})`;

    currentGiftMaxTarget = metrics.remaining > 0 ? metrics.remaining : metrics.goal;

    const slider = document.getElementById('pledgeAmountSlider');
    slider.min = '0';
    slider.max = String(currentGiftMaxTarget);
    slider.step = '1';

    document.getElementById('sliderMidLabel').textContent = formatKRW(Math.round(currentGiftMaxTarget / 2));
    document.getElementById('sliderMaxLabel').textContent =
      metrics.remaining > 0
        ? `최대 ${formatKRW(currentGiftMaxTarget)}`
        : `목표액 ${formatKRW(currentGiftMaxTarget)}`;

    const fillBtn = document.getElementById('fillRemainingBtn');
    fillBtn.hidden = false;
    fillBtn.textContent = metrics.remaining > 0
      ? `남은 ${formatKRW(metrics.remaining)} 채우기`
      : `목표액 ${formatKRW(metrics.goal)} 채우기`;

    const currentAmount = Number(document.getElementById('pledgeAmountInput').value) || 0;
    updatePledgeAmountUI(currentAmount);
  }

  function updatePledgeAmountUI(newAmount, fromSlider) {
    let clean = Math.max(0, Math.round(Number(newAmount) || 0));

    if (fromSlider) {
      if (clean >= currentGiftMaxTarget - 1000) {
        clean = currentGiftMaxTarget;
      } else if (clean > 0 && clean < 1000) {
        clean = 1000;
      } else {
        clean = Math.round(clean / 1000) * 1000;
      }
    }

    const input = document.getElementById('pledgeAmountInput');
    const slider = document.getElementById('pledgeAmountSlider');
    const formatted = document.getElementById('pledgeAmountFormatted');
    const guideAmount = document.getElementById('guideSelectedAmount');
    const copyAmountText = document.getElementById('copyAmountBtnText');

    const effectiveMax = Math.max(currentGiftMaxTarget, clean);
    slider.max = String(effectiveMax);

    input.value = clean;
    slider.value = String(clean);
    formatted.textContent = formatNumberKo(clean);
    if (guideAmount) guideAmount.textContent = formatNumberKo(clean);
    if (copyAmountText) copyAmountText.textContent = `${formatNumberKo(clean)} 복사`;

    const giftId = document.getElementById('pledgeGiftSelect').value;
    const gift = state.gifts.find((g) => g.id === giftId);
    if (gift) {
      const goal = Math.max(1, Number(gift.goalAmount) || 1);
      const boostPercent = Math.max(0, Math.round((clean / goal) * 100));
      document.getElementById('pledgeImpactBadge').textContent = `승인 시 달성률 +${boostPercent}%`;
    }

    updateSelectedRemitMethodPreview();
  }

  function handleOpenRemitUrl(type) {
    const rawUrl = type === 'kakao' ? state.campaign.kakaoRemitUrl : state.campaign.tossRemitUrl;
    const validUrl = getValidHttpUrl(rawUrl);
    const label = type === 'kakao' ? '카카오페이' : '토스';
    const amount = Math.round(Number(document.getElementById('pledgeAmountInput').value) || 0);

    if (!validUrl) {
      showToast(`아직 ${state.campaign.hostName}님의 ${label} 송금 링크가 등록되지 않았습니다.`);
      return;
    }

    if (amount < 1000) {
      const errorEl = document.getElementById('pledgeErrorMsg');
      errorEl.textContent = '먼저 펀딩할 금액(최소 1,000원 이상)을 입력해 주세요.';
      errorEl.hidden = false;
      document.getElementById('pledgeAmountInput').focus();
      return;
    }

    window.open(validUrl, '_blank', 'noopener,noreferrer');
    showToast(`${label} 송금 창을 열었습니다. 받는 분(${state.campaign.hostName})과 금액(${formatNumberKo(amount)})을 확인 후 송금해 주세요.`);
  }

  function handleCopyBankAccount() {
    const bankName = (state.campaign.bankName || '').trim();
    const bankAccount = (state.campaign.bankAccount || '').trim();
    if (!bankAccount) {
      showToast('등록된 계좌번호가 없습니다.');
      return;
    }

    const copyStr = bankName ? `${bankName} ${bankAccount}` : bankAccount;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(copyStr).then(() => {
        showToast(`✅ 계좌번호(${copyStr})가 복사되었습니다!`);
      }).catch(() => {
        showToast(`계좌번호: ${copyStr} (예금주: ${state.campaign.hostName})`);
      });
    } else {
      showToast(`계좌번호: ${copyStr} (예금주: ${state.campaign.hostName})`);
    }
  }

  async function handlePledgeSubmit(e) {
    e.preventDefault();

    const nowMs = Date.now();
    if (isSubmittingPledge || nowMs - lastSubmitTimestamp < 1800) {
      return;
    }

    const errorEl = document.getElementById('pledgeErrorMsg');
    const giftId = document.getElementById('pledgeGiftSelect').value;
    const rawAmount = Number(document.getElementById('pledgeAmountInput').value);
    const amount = Math.round(rawAmount || 0);
    const senderName = document.getElementById('pledgeSenderName').value.trim();
    const relation = document.getElementById('pledgeRelation').value.trim() || '친구';
    const message = document.getElementById('pledgeMessageInput').value.trim();
    const selfPin = document.getElementById('pledgeSelfPinInput').value.trim();
    const honeypot = document.getElementById('pledgeHoneypotInput').value;
    const hasSelectedPhoto = Boolean(pledgeAvatarDataUrl && pledgeAvatarDataUrl.length > 0);
    const consentChecked = document.getElementById('pledgePhotoConsentCheck').checked;
    const submitBtn = document.getElementById('submitSentBtn');
    const submitBtnText = document.getElementById('submitPledgeBtnText');

    errorEl.hidden = true;

    if (honeypot) {
      errorEl.textContent = '비정상적인 요청이 감지되었습니다.';
      errorEl.hidden = false;
      return;
    }

    if (!Number.isFinite(rawAmount) || amount < 1000 || amount > 50000000) {
      errorEl.textContent = '펀딩 금액은 최소 1,000원 이상 ~ 5,000만 원 이하로 유효하게 입력해주세요.';
      errorEl.hidden = false;
      return;
    }
    if (hasSelectedPhoto && !consentChecked) {
      errorEl.textContent = '프로필 사진을 등록하려면 공개 페이지 사진 게시 동의에 체크해 주세요.';
      errorEl.hidden = false;
      document.getElementById('pledgePhotoConsentCheck').focus();
      return;
    }
    if (hasSelectedPhoto && selfPin.length < 4) {
      errorEl.textContent = '본인만 프로필 사진을 수정·삭제할 수 있도록 4자리 이상의 비밀번호를 입력해 주세요.';
      errorEl.hidden = false;
      document.getElementById('pledgeSelfPinInput').focus();
      return;
    }
    if (!hasSelectedPhoto && selfPin.length > 0 && selfPin.length < 4) {
      errorEl.textContent = '비밀번호를 설정하려면 4자리 이상 입력해 주세요.';
      errorEl.hidden = false;
      document.getElementById('pledgeSelfPinInput').focus();
      return;
    }
    if (!senderName) {
      errorEl.textContent = '실제 입금 확인을 위해 보내는 분(입금자) 이름을 입력해주세요.';
      errorEl.hidden = false;
      document.getElementById('pledgeSenderName').focus();
      return;
    }
    if (!message) {
      errorEl.textContent = `${state.campaign.hostName}님에게 전할 응원 메시지를 입력해주세요.`;
      errorEl.hidden = false;
      document.getElementById('pledgeMessageInput').focus();
      return;
    }

    // Verify chosen remittance method
    const chosenMethod = currentSelectedRemitMethod || 'bank';
    const validKakao = getValidHttpUrl(state.campaign.kakaoRemitUrl);
    const validToss = getValidHttpUrl(state.campaign.tossRemitUrl);
    const hasBank = Boolean((state.campaign.bankAccount || '').trim());

    if (!validKakao && !validToss && !hasBank) {
      errorEl.textContent = '펀딩 주인에게 아직 등록된 송금 계좌나 링크가 없습니다. 펀딩 주인에게 문의해 주세요.';
      errorEl.hidden = false;
      return;
    }

    isSubmittingPledge = true;
    submitBtn.disabled = true;

    let finalAvatarUrl = pledgeAvatarDataUrl || '';

    try {
      if (hasSelectedPhoto && pledgeAvatarBlob && isSupabaseConfigured() && isCloudConnected) {
        if (submitBtnText) submitBtnText.textContent = '☁️ 프로필 사진 업로드 중...';
        finalAvatarUrl = await uploadToSupabaseStorage(pledgeAvatarBlob, pledgeAvatarMime, 'avatars');
      }

      const targetGift = state.gifts.find((g) => g.id === giftId);
      const currentMetrics = targetGift ? getGiftMetrics(targetGift) : { rawPercent: 0, raised: 0, goal: 1 };
      const expectedAfterApprovePercent = Math.round(((currentMetrics.raised + amount) / currentMetrics.goal) * 100);

      const now = new Date();
      const dateStamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      // 1. Save cheer message and pending contribution FIRST!
      if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
        if (submitBtnText) submitBtnText.textContent = '☁️ 응원 메시지 및 신청 등록 중...';

        const { data: contribRes, error: rpcErr } = await supabaseClient.rpc('create_pending_contribution', {
          p_campaign_id: currentCampaignId,
          p_gift_id: giftId,
          p_sender_name: senderName,
          p_relation: relation,
          p_amount: amount,
          p_message: message,
          p_avatar_url: finalAvatarUrl,
          p_theme: selectedCardTheme,
          p_created_at_label: dateStamp,
          p_pin: selfPin,
          p_honeypot: honeypot
        });

        if (rpcErr) {
          throw new Error(rpcErr.message || '펀딩 참여 등록 실패');
        }
        if (contribRes && contribRes.ok === false) {
          throw new Error(contribRes.message || '펀딩 참여 등록 실패');
        }

        await fetchCampaignFromSupabase(currentCampaignId, true);
      } else {
        // Virtual/Local preview fallback mode
        const newPledgeId = 'pledge-' + Date.now() + '-' + generateRandomHex(4);
        const pinSalt = selfPin.length >= 4 ? generateRandomHex(6) : '';
        const pinHash = selfPin.length >= 4 ? computeLocalHash(selfPin, pinSalt) : '';

        state.contributions.push({
          id: newPledgeId,
          campaignId: currentCampaignId,
          giftId,
          senderName,
          relation,
          amount,
          message,
          avatarUrl: finalAvatarUrl,
          pinSalt,
          pinHash,
          theme: selectedCardTheme,
          status: 'pending',
          cheers: 0,
          cheeredByMe: false,
          createdAt: dateStamp
        });
        saveCurrentStateToLocalMultiDb();
        renderApp();
      }

      lastSubmitTimestamp = Date.now();
      lastPledgedGift = targetGift;

      // 2. Set up the Receipt & Remittance Action View
      document.getElementById('receiptAvatarWrap').innerHTML = renderAvatarMediaHtml(finalAvatarUrl, senderName);
      document.getElementById('receiptSender').textContent = `${senderName} (${relation})`;
      const evGiftWord = (state.campaign.eventType === 'birthday') ? '생일 선물' : '선물';
      document.getElementById('receiptGiftName').textContent = targetGift ? targetGift.title : `${state.campaign.hostName}님의 ${evGiftWord}`;
      document.getElementById('receiptAmount').textContent = formatKRW(amount);
      document.getElementById('receiptProgressJump').textContent =
        `현재 ${currentMetrics.rawPercent}% 유지 (펀딩 주인 입금 확인 후 ${expectedAfterApprovePercent}% 반영)`;
      document.getElementById('receiptMessagePreview').textContent = `"${message}"`;

      // Render the method-specific Remittance Action Card in receipt view
      renderReceiptRemitAction(chosenMethod, amount);

      // Switch to the receipt view immediately
      document.getElementById('pledgeFormView').hidden = true;
      document.getElementById('pledgeReceiptView').hidden = false;

      // Clear input fields
      document.getElementById('pledgeSenderName').value = '';
      document.getElementById('pledgeMessageInput').value = '';
      document.getElementById('pledgeSelfPinInput').value = '';
      document.getElementById('msgCharCount').textContent = '0';
      resetPledgeAvatarState();

      showToast('💌 응원 메시지가 등록되었습니다! 송금을 완료해 주세요.');

      // Play bunny celebration animation & sound
      playBunnyCelebration(targetGift);

      // 3. Automated App Launch for Kakao / Toss (Mobile & Desktop friendly)
      let targetRemitUrl = '';
      if (chosenMethod === 'kakao') {
        targetRemitUrl = validKakao;
      } else if (chosenMethod === 'toss') {
        targetRemitUrl = validToss;
      }

      if (targetRemitUrl) {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        try {
          if (isMobile) {
            window.location.href = targetRemitUrl;
          } else {
            window.open(targetRemitUrl, '_blank', 'noopener,noreferrer');
          }
        } catch (openErr) {
          console.warn('[Remit] Automatic redirect was blocked by browser:', openErr);
        }
      }
    } catch (err) {
      errorEl.textContent = `후원 신청 저장 오류: ${err.message || '처리 중 오류가 발생했습니다'}. 다시 시도해 주세요.`;
      errorEl.hidden = false;
      if (submitBtnText) submitBtnText.textContent = '🔄 다시 시도하기';
    } finally {
      isSubmittingPledge = false;
      submitBtn.disabled = false;
      updatePledgeAmountUI(amount, false);
    }
  }

  // =========================================================================
  // 6. SELF-SERVICE PARTICIPANT PROFILE PHOTO EDIT / DELETE MODAL
  // =========================================================================
  function updateManageModalAvatarPreview(srcUrl) {
    const img = document.getElementById('manageAvatarPreviewImg');
    const defIcon = document.getElementById('manageAvatarDefaultIcon');
    const consentWrap = document.getElementById('manageConsentWrap');

    if (srcUrl && srcUrl.trim() !== '') {
      img.src = srcUrl;
      img.hidden = false;
      defIcon.hidden = true;
    } else {
      img.src = '';
      img.hidden = true;
      defIcon.hidden = false;
    }

    consentWrap.hidden = !Boolean(manageAvatarDataUrl);
  }

  function openAvatarManageModal(pledgeId) {
    const target = state.contributions.find((c) => c.id === pledgeId);
    if (!target) return;

    const backdrop = document.getElementById('avatarManageModalBackdrop');
    const errEl = document.getElementById('avatarManageErrorMsg');
    errEl.hidden = true;

    document.getElementById('managePledgeId').value = target.id;
    document.getElementById('avatarManageTargetName').textContent = isAdminAuthenticated
      ? `[펀딩 주인 권한] ${target.senderName}님의 프로필 사진을 변경하거나 삭제할 수 있습니다.`
      : `${target.senderName}님의 프로필 사진을 변경하거나 삭제합니다. 참여 시 설정한 비밀번호를 입력해 주세요.`;
    document.getElementById('managePinVerifyInput').value = '';
    document.getElementById('managePinVerifyInput').required = !isAdminAuthenticated;
    document.getElementById('manageAvatarFileInput').value = '';
    document.getElementById('managePhotoConsentCheck').checked = false;

    manageAvatarDataUrl = '';
    manageAvatarBlob = null;
    manageAvatarMime = 'image/webp';
    manageAvatarRemoved = false;

    updateManageModalAvatarPreview(target.avatarUrl || '');

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeAvatarManageModal() {
    const backdrop = document.getElementById('avatarManageModalBackdrop');
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  async function handleAvatarManageSubmit(e) {
    e.preventDefault();
    const pledgeId = document.getElementById('managePledgeId').value;
    const target = state.contributions.find((c) => c.id === pledgeId);
    const errEl = document.getElementById('avatarManageErrorMsg');
    const pinInput = document.getElementById('managePinVerifyInput').value.trim();
    const saveBtn = document.getElementById('saveAvatarManageBtn');

    errEl.hidden = true;
    if (!target) return;

    if (!isAdminAuthenticated && !pinInput) {
      errEl.textContent = '참여 시 설정한 비밀번호를 입력해 주세요.';
      errEl.hidden = false;
      document.getElementById('managePinVerifyInput').focus();
      return;
    }

    if (manageAvatarDataUrl && !document.getElementById('managePhotoConsentCheck').checked) {
      errEl.textContent = '새 프로필 사진을 게시하려면 공개 페이지 사진 게시 동의에 체크해 주세요.';
      errEl.hidden = false;
      return;
    }

    let nextAvatarUrl = target.avatarUrl || '';

    saveBtn.disabled = true;
    saveBtn.textContent = '처리 중...';

    try {
      if (manageAvatarRemoved) {
        nextAvatarUrl = '';
      } else if (manageAvatarDataUrl) {
        if (manageAvatarBlob && isSupabaseConfigured() && isCloudConnected) {
          saveBtn.textContent = '☁️ 업로드 중...';
          nextAvatarUrl = await uploadToSupabaseStorage(manageAvatarBlob, manageAvatarMime, 'avatars');
        } else {
          nextAvatarUrl = manageAvatarDataUrl;
        }
      }

      if (isCloudConnected && supabaseClient) {
        const ownerToken = getStoredOwnerSessionToken(currentCampaignId);
        const { data: verifiedRes, error: rpcErr } = await supabaseClient.rpc('manage_own_avatar', {
          p_campaign_id: currentCampaignId,
          p_contribution_id: pledgeId,
          p_pin: pinInput,
          p_new_avatar_url: nextAvatarUrl,
          p_owner_session_token: ownerToken
        });

        if (rpcErr) {
          throw new Error(rpcErr.message);
        }
        const isAvatarOk =
          verifiedRes === true ||
          (verifiedRes && typeof verifiedRes === 'object' && verifiedRes.ok === true);
        if (!isAvatarOk) {
          throw new Error(
            (verifiedRes && verifiedRes.message) ||
              '비밀번호가 일치하지 않거나 사진 관리 비밀번호가 설정되지 않은 내역입니다.'
          );
        }

        await fetchCampaignFromSupabase(currentCampaignId, true);
      } else {
        if (!isAdminAuthenticated) {
          if (!target.pinHash || !target.pinSalt) {
            throw new Error('이 참여 내역에는 사진 관리 비밀번호가 설정되어 있지 않아 변경할 수 없습니다.');
          }
          if (target.pinLockedUntil && target.pinLockedUntil > Date.now()) {
            const mins = Math.max(1, Math.ceil((target.pinLockedUntil - Date.now()) / 60000));
            throw new Error(`비밀번호 5회 연속 오류로 사진 변경이 잠겼습니다. 약 ${mins}분 후 다시 시도해 주세요.`);
          }
          const candidateHash = computeLocalHash(pinInput, target.pinSalt);
          if (candidateHash !== target.pinHash) {
            target.pinFailedAttempts = (target.pinFailedAttempts || 0) + 1;
            if (target.pinFailedAttempts >= 5) {
              target.pinFailedAttempts = 0;
              target.pinLockedUntil = Date.now() + 15 * 60 * 1000;
              saveCurrentStateToLocalMultiDb();
              throw new Error('비밀번호를 5회 연속 틀려 15분간 사진 변경이 잠겼습니다.');
            }
            saveCurrentStateToLocalMultiDb();
            throw new Error(`비밀번호가 일치하지 않습니다. (남은 시도 횟수: ${5 - target.pinFailedAttempts}회)`);
          }
          target.pinFailedAttempts = 0;
          target.pinLockedUntil = 0;
        }
        target.avatarUrl = nextAvatarUrl;
        saveCurrentStateToLocalMultiDb();
        renderApp();
      }

      closeAvatarManageModal();
      showToast(manageAvatarRemoved ? '프로필 사진이 삭제되어 기본 아이콘으로 변경되었습니다.' : '프로필 사진이 업데이트되었습니다.');
    } catch (err) {
      errEl.textContent = err.message || '사진 변경에 실패했습니다.';
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '변경사항 적용하기';
    }
  }

  // =========================================================================
  // 7. GIFT ADD / EDIT MODAL (Funding Owner Only — Server Session Enforced)
  // =========================================================================
  function updateEditorPhotoPreview(srcUrl, fitMode) {
    const previewImg = document.getElementById('giftPhotoPreviewImg');
    const placeholder = document.getElementById('giftPhotoPlaceholder');
    const removeBtn = document.getElementById('removeGiftPhotoBtn');
    const recropBtn = document.getElementById('recropGiftPhotoBtn');

    previewImg.classList.toggle('fit-contain', fitMode === 'contain');

    if (srcUrl && srcUrl.trim() !== '') {
      previewImg.src = srcUrl;
      previewImg.hidden = false;
      placeholder.hidden = true;
      removeBtn.hidden = false;
      if (recropBtn) recropBtn.hidden = false;
    } else {
      previewImg.src = '';
      previewImg.hidden = true;
      placeholder.hidden = false;
      removeBtn.hidden = true;
      if (recropBtn) recropBtn.hidden = true;
    }

    const noticeEl = document.getElementById('giftStorageNotice');
    if (isSupabaseConfigured() && isCloudConnected) {
      noticeEl.className = 'storage-status-notice cloud-ready';
      noticeEl.innerHTML =
        '☁️ <strong>Supabase Storage 연결됨:</strong> 선물 사진을 업로드하고 저장하면 클라우드 저장소와 DB에 저장되어 모든 방문자에게 공유됩니다.';
    } else {
      noticeEl.className = 'storage-status-notice';
      noticeEl.innerHTML =
        '💡 <strong>저장 안내:</strong> 현재 로컬 미리보기 상태입니다.';
    }
  }

  function getSelectedImageFit() {
    const checked = document.querySelector('input[name="giftImageFit"]:checked');
    return checked && checked.value === 'contain' ? 'contain' : 'cover';
  }

  function setSelectedImageFit(fitValue) {
    const radios = document.querySelectorAll('input[name="giftImageFit"]');
    radios.forEach((r) => {
      r.checked = r.value === (fitValue === 'contain' ? 'contain' : 'cover');
    });
  }

  function openGiftModal(editGiftId) {
    if (!requireAdminPermission('위시리스트 선물 추가 및 수정')) return;

    const backdrop = document.getElementById('giftModalBackdrop');
    const modalTitle = document.getElementById('giftModalTitle');
    const idInput = document.getElementById('editGiftId');
    const catSelect = document.getElementById('giftCategorySelect');
    const prioSelect = document.getElementById('giftPrioritySelect');
    const titleInput = document.getElementById('giftTitleInput');
    const brandInput = document.getElementById('giftBrandInput');
    const goalInput = document.getElementById('giftGoalInput');
    const descInput = document.getElementById('giftDescInput');
    const urlInput = document.getElementById('giftImageUrlInput');
    const productUrlInput = document.getElementById('giftProductUrlInput');
    const fileInput = document.getElementById('giftPhotoFileInput');
    const errEl = document.getElementById('giftFormErrorMsg');

    errEl.hidden = true;
    fileInput.value = '';
    editorPhotoDataUrl = '';
    editorPhotoBlob = null;
    giftPhotoRawSource = null;

    if (editGiftId) {
      const existing = state.gifts.find((g) => g.id === editGiftId);
      if (existing) {
        modalTitle.textContent = '선물 정보 및 사진 수정';
        idInput.value = existing.id;
        catSelect.value = existing.category || 'fashion';
        prioSelect.value = String(existing.priority || 1);
        titleInput.value = existing.title;
        brandInput.value = existing.brand || '';
        goalInput.value = existing.goalAmount;
        descInput.value = existing.description || '';
        if (productUrlInput) productUrlInput.value = existing.productUrl || '';

        const fit = existing.imageFit || 'cover';
        setSelectedImageFit(fit);

        if (existing.imageUrl && existing.imageUrl.startsWith('data:image/')) {
          editorPhotoDataUrl = existing.imageUrl;
          urlInput.value = '';
          updateEditorPhotoPreview(editorPhotoDataUrl, fit);
        } else {
          urlInput.value = existing.imageUrl || '';
          updateEditorPhotoPreview(existing.imageUrl || '', fit);
        }
      }
    } else {
      modalTitle.textContent = '새 위시리스트 선물 추가';
      idInput.value = '';
      catSelect.value = 'fashion';
      prioSelect.value = '1';
      titleInput.value = '';
      brandInput.value = '';
      goalInput.value = 150000;
      descInput.value = '';
      urlInput.value = '';
      if (productUrlInput) productUrlInput.value = '';
      setSelectedImageFit('cover');
      updateEditorPhotoPreview('', 'cover');
    }

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeGiftModal() {
    const backdrop = document.getElementById('giftModalBackdrop');
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  async function handleGiftFormSubmit(e) {
    e.preventDefault();
    if (!requireAdminPermission('위시리스트 선물 저장')) return;

    const editId = document.getElementById('editGiftId').value;
    const category = document.getElementById('giftCategorySelect').value;
    const priority = Number(document.getElementById('giftPrioritySelect').value) || 1;
    const title = document.getElementById('giftTitleInput').value.trim();
    const brand = document.getElementById('giftBrandInput').value.trim() || `${state.campaign.hostName} WISHLIST`;
    const goalAmount = Math.max(1000, Math.round(Number(document.getElementById('giftGoalInput').value) || 100000));
    const evGiftDesc = (state.campaign.eventType === 'birthday') ? '생일 위시리스트 선물' : '위시리스트 선물';
    const description = document.getElementById('giftDescInput').value.trim() || `${state.campaign.hostName}님의 ${evGiftDesc}입니다.`;
    const manualUrl = document.getElementById('giftImageUrlInput').value.trim();
    const rawProductUrl = (document.getElementById('giftProductUrlInput')?.value || '').trim();
    const imageFit = getSelectedImageFit();
    const errEl = document.getElementById('giftFormErrorMsg');
    const submitBtn = document.getElementById('saveGiftSubmitBtn');

    errEl.hidden = true;

    if (!title) {
      errEl.textContent = '선물 이름을 입력해주세요.';
      errEl.hidden = false;
      document.getElementById('giftTitleInput').focus();
      return;
    }

    let productUrl = '';
    if (rawProductUrl) {
      productUrl = normalizeWebUrl(rawProductUrl);
      if (!productUrl) {
        errEl.textContent = '올바른 쇼핑몰 웹사이트 URL을 입력해 주세요. (예: https://...)';
        errEl.hidden = false;
        document.getElementById('giftProductUrlInput').focus();
        return;
      }
    }

    let finalImageUrl = manualUrl || editorPhotoDataUrl || '';

    submitBtn.disabled = true;
    submitBtn.textContent = '저장 중...';

    try {
      if (editorPhotoBlob && isSupabaseConfigured() && isCloudConnected) {
        submitBtn.textContent = '☁️ 이미지 업로드 중...';
        finalImageUrl = await uploadToSupabaseStorage(editorPhotoBlob, editorPhotoMime, 'gifts');
      }

      if (isCloudConnected && supabaseClient) {
        const token = getStoredOwnerSessionToken(currentCampaignId);
        let saveRes = await supabaseClient.rpc('owner_save_gift', {
          p_campaign_id: currentCampaignId,
          p_session_token: token,
          p_gift_id: editId || '',
          p_category: category,
          p_priority: priority,
          p_title: title,
          p_brand: brand,
          p_goal_amount: goalAmount,
          p_description: description,
          p_image_url: finalImageUrl,
          p_image_fit: imageFit,
          p_product_url: productUrl
        });

        // Pre-migration fallback: if 12-param RPC not found yet, call 11-param version
        if (saveRes.error && /could not find the function/i.test(saveRes.error.message || '')) {
          console.warn('[GiftSave] Falling back to 11-param owner_save_gift');
          saveRes = await supabaseClient.rpc('owner_save_gift', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_gift_id: editId || '',
            p_category: category,
            p_priority: priority,
            p_title: title,
            p_brand: brand,
            p_goal_amount: goalAmount,
            p_description: description,
            p_image_url: finalImageUrl,
            p_image_fit: imageFit
          });
        }

        if (saveRes.error) {
          throw new Error(saveRes.error.message);
        }
        await fetchCampaignFromSupabase(currentCampaignId, true);
      } else {
        const giftId = editId || `${currentCampaignId}-gift-${Date.now()}`;
        if (editId) {
          const idx = state.gifts.findIndex((g) => g.id === editId);
          if (idx !== -1) {
            state.gifts[idx] = {
              ...state.gifts[idx],
              category,
              priority,
              title,
              brand,
              goalAmount,
              description,
              imageUrl: finalImageUrl,
              imageFit,
              productUrl
            };
          }
        } else {
          state.gifts.push({
            id: giftId,
            campaignId: currentCampaignId,
            category,
            priority,
            title,
            brand,
            goalAmount,
            description,
            imageUrl: finalImageUrl,
            imageFit,
            productUrl
          });
        }
        saveCurrentStateToLocalMultiDb();
        renderApp();
      }

      closeGiftModal();
      showToast('위시리스트 선물이 저장되었습니다!');
    } catch (err) {
      errEl.textContent = err.message || '선물 저장 중 오류가 발생했습니다.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '선물 저장하기';
    }
  }

  // =========================================================================
  // 8. FUNDING OWNER — REMITTANCE & PROFILE SETTINGS MODAL
  // =========================================================================
  let profileSelectedIntroFile = null;
  let profileIntroPhotoMarkedForDelete = false;

  function openProfileModal() {
    if (!requireAdminPermission('송금 수단 및 프로필 설정')) return;

    const { campaign } = state;
    const urlError = document.getElementById('tossUrlErrorMsg');
    urlError.hidden = true;

    document.getElementById('bankNameInput').value = campaign.bankName || '';
    document.getElementById('bankAccountInput').value = campaign.bankAccount || '';
    document.getElementById('kakaoRemitUrlInput').value = campaign.kakaoRemitUrl || '';
    document.getElementById('tossRemitUrlInput').value = campaign.tossRemitUrl || '';

    document.getElementById('hostNameEditInput').value = campaign.hostName || '';
    document.getElementById('hostEmojiSelect').value = campaign.emoji || '🎂';
    document.getElementById('hostBirthdayInput').value = campaign.birthdayDate || getTodayDateString();
    document.getElementById('hostHeadlineInput').value = campaign.headline || '';
    document.getElementById('hostSubtitleInput').value = campaign.subtitle || '';
    document.getElementById('hostBioInput').value = campaign.bio || '';

    const profileEventTypeSel = document.getElementById('profileEventTypeSelect');
    const profileEventCustomInp = document.getElementById('profileEventCustomTextInput');
    const profileEventCustomBox = document.getElementById('profileEventCustomBox');
    if (profileEventTypeSel) {
      profileEventTypeSel.value = campaign.eventType || 'birthday';
    }
    if (profileEventCustomInp) {
      profileEventCustomInp.value = campaign.introMessage || '';
    }
    if (profileEventCustomBox) {
      profileEventCustomBox.hidden = (!profileEventTypeSel || profileEventTypeSel.value !== 'custom');
    }

    // Reset intro photo management state in owner settings
    profileSelectedIntroFile = null;
    profileSelectedIntroBlob = null;
    profileIntroPhotoRawSource = null;
    profileIntroPhotoCropDataUrl = '';
    profileIntroPhotoMarkedForDelete = false;

    const photoInput = document.getElementById('profileIntroPhotoInput');
    if (photoInput) photoInput.value = '';

    const fitSelect = document.getElementById('profileIntroPhotoFitSelect');
    if (fitSelect) fitSelect.value = campaign.introImageFit === 'contain' ? 'contain' : 'cover';

    const photoThumb = document.getElementById('profileIntroPhotoImg');
    const photoPlaceholder = document.getElementById('profileIntroPhotoPlaceholder');
    const deleteBtn = document.getElementById('profileIntroPhotoDeleteBtn');
    const recropBtn = document.getElementById('profileIntroPhotoRecropBtn');
    const statusText = document.getElementById('profileIntroPhotoStatusText');
    if (statusText) statusText.textContent = '';

    if (photoThumb) {
      if (campaign.introImageUrl) {
        photoThumb.src = getIntroPhotoPublicUrl(campaign.introImageUrl);
        photoThumb.className = `intro-preview-thumbnail fit-${campaign.introImageFit || 'cover'}`;
        photoThumb.hidden = false;
        if (photoPlaceholder) photoPlaceholder.hidden = true;
        if (deleteBtn) deleteBtn.hidden = false;
        if (recropBtn) recropBtn.hidden = false;
      } else {
        photoThumb.src = '';
        photoThumb.hidden = true;
        if (photoPlaceholder) photoPlaceholder.hidden = false;
        if (deleteBtn) deleteBtn.hidden = true;
        if (recropBtn) recropBtn.hidden = true;
      }
    }

    // Pending delete retry banner in Owner settings
    const pendingBox = document.getElementById('profilePendingDeleteBox');
    const pendingFilename = document.getElementById('profilePendingDeleteFilename');
    if (pendingBox) {
      if (campaign.pendingDeleteImageUrl) {
        pendingBox.hidden = false;
        if (pendingFilename) pendingFilename.textContent = campaign.pendingDeleteImageUrl;
      } else {
        pendingBox.hidden = true;
        if (pendingFilename) pendingFilename.textContent = '';
      }
    }

    const backdrop = document.getElementById('profileModalBackdrop');
    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeProfileModal() {
    const backdrop = document.getElementById('profileModalBackdrop');
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  async function handleProfileFormSubmit(e) {
    e.preventDefault();
    if (!requireAdminPermission('송금 및 캠페인 설정 저장')) return;

    const bankName = document.getElementById('bankNameInput').value.trim();
    const bankAccount = document.getElementById('bankAccountInput').value.trim();
    const rawKakaoUrl = document.getElementById('kakaoRemitUrlInput').value.trim();
    const rawTossUrl = document.getElementById('tossRemitUrlInput').value.trim();
    const eventTypeSelect = document.getElementById('profileEventTypeSelect');
    const eventType = (eventTypeSelect && eventTypeSelect.value) || 'general';
    const customMsgInput = document.getElementById('profileEventCustomTextInput');
    const customMsg = (customMsgInput && customMsgInput.value.trim()) || '';
    const eventCfg = EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.general;

    const hostName = document.getElementById('hostNameEditInput').value.trim();
    const emoji = document.getElementById('hostEmojiSelect').value;
    const birthdayDate = document.getElementById('hostBirthdayInput').value;
    const headline = document.getElementById('hostHeadlineInput').value.trim() || eventCfg.defaultHeadline(hostName);
    const subtitle = document.getElementById('hostSubtitleInput').value.trim() || eventCfg.defaultSubtitle;
    const bio = document.getElementById('hostBioInput').value.trim();
    const urlError = document.getElementById('tossUrlErrorMsg');

    if (!hostName) {
      urlError.textContent = '주인공 이름을 입력해 주세요.';
      urlError.hidden = false;
      return;
    }

    if (rawKakaoUrl !== '' && !getValidHttpUrl(rawKakaoUrl)) {
      urlError.textContent = '카카오페이 송금 링크는 유효한 웹 주소(https://...)로 입력해 주세요.';
      urlError.hidden = false;
      return;
    }

    if (rawTossUrl !== '' && !getValidHttpUrl(rawTossUrl)) {
      urlError.textContent = '토스 송금 링크는 유효한 웹 주소(https://...)로 입력해 주세요.';
      urlError.hidden = false;
      return;
    }

    urlError.hidden = true;
    const cleanKakao = rawKakaoUrl ? getValidHttpUrl(rawKakaoUrl) : '';
    const cleanToss = rawTossUrl ? getValidHttpUrl(rawTossUrl) : '';
    const introFitVal = (document.getElementById('profileIntroPhotoFitSelect')?.value === 'contain') ? 'contain' : 'cover';

    if (isCloudConnected && supabaseClient) {
      const token = getStoredOwnerSessionToken(currentCampaignId);
      let updateRes = await supabaseClient.rpc('owner_update_campaign', {
        p_campaign_id: currentCampaignId,
        p_session_token: token,
        p_host_name: hostName,
        p_emoji: emoji,
        p_birthday_date: birthdayDate,
        p_headline: headline,
        p_subtitle: subtitle,
        p_bio: bio,
        p_bank_name: bankName,
        p_bank_account: bankAccount,
        p_kakao_remit_url: cleanKakao,
        p_toss_remit_url: cleanToss,
        p_event_type: eventType,
        p_intro_message: customMsg
      });

      // Pre-migration fallback: if 14-parameter function not found yet, call 12-param version
      if (updateRes.error && /could not find the function/i.test(updateRes.error.message || '')) {
        console.warn('[ProfileUpdate] Falling back to 12-param owner_update_campaign');
        updateRes = await supabaseClient.rpc('owner_update_campaign', {
          p_campaign_id: currentCampaignId,
          p_session_token: token,
          p_host_name: hostName,
          p_emoji: emoji,
          p_birthday_date: birthdayDate,
          p_headline: headline,
          p_subtitle: subtitle,
          p_bio: bio,
          p_bank_name: bankName,
          p_bank_account: bankAccount,
          p_kakao_remit_url: cleanKakao,
          p_toss_remit_url: cleanToss
        });
      }

      if (updateRes.error) {
        urlError.textContent = `설정 저장 실패: ${updateRes.error.message}`;
        urlError.hidden = false;
        return;
      }

      // Handle intro photo changes with owner authentication
      if (profileSelectedIntroFile) {
        if (!token) {
          urlError.textContent = '관리자 세션 토큰이 유효하지 않습니다. 관리 비밀번호로 다시 로그인해 주세요.';
          urlError.hidden = false;
          openAdminAuthModal();
          return;
        }

        let newObjectPath = '';
        try {
          newObjectPath = await uploadIntroPhotoToStorage(profileSelectedIntroFile, currentCampaignId);
          const { data: setRes, error: setErr } = await supabaseClient.rpc('owner_set_intro_photo', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_object_path: newObjectPath,
            p_intro_image_fit: introFitVal
          });

          if (setErr || !setRes || !setRes.ok) {
            await removeStorageObjectSafely(newObjectPath);
            const detailedMsg = formatSupabaseRpcError(setErr, setRes, '사진 변경에 실패했습니다.');
            console.error('[IntroPhoto] owner_set_intro_photo failed:', setErr, setRes);
            throw new Error(detailedMsg);
          }

          // If replaced successfully, attempt to remove previous photo from Storage via API
          if (setRes.previous_image_url) {
            const cfg = resolveSupabaseConnectionConfig();
            const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
            const { error: removeErr } = await supabaseClient.storage.from(bucketName).remove([setRes.previous_image_url]);
            if (removeErr) {
              console.warn('[IntroPhoto] Storage file removal warning:', removeErr);
              showToast(`⚠️ 새 사진은 등록되었으나 이전 파일의 Storage 삭제에 실패했습니다: ${removeErr.message}. 관리자 설정에서 다시 삭제할 수 있습니다.`, 6000);
            } else {
              // Confirm deletion in DB so pending_delete_image_url is cleared
              await supabaseClient.rpc('owner_confirm_intro_deleted', {
                p_campaign_id: currentCampaignId,
                p_session_token: token,
                p_deleted_path: setRes.previous_image_url
              });
            }
          }
        } catch (photoErr) {
          console.error('[IntroPhoto] Photo update caught error:', photoErr);
          urlError.textContent = `설정 저장 중 인트로 사진 변경 실패: ${photoErr.message}`;
          urlError.hidden = false;
          return;
        }
      } else if (profileIntroPhotoMarkedForDelete) {
        if (!token) {
          urlError.textContent = '관리자 세션 토큰이 유효하지 않습니다. 관리 비밀번호로 다시 로그인해 주세요.';
          urlError.hidden = false;
          openAdminAuthModal();
          return;
        }

        try {
          const { data: setRes, error: setErr } = await supabaseClient.rpc('owner_set_intro_photo', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_object_path: '',
            p_intro_image_fit: 'cover'
          });

          if (setErr || !setRes || !setRes.ok) {
            const detailedMsg = formatSupabaseRpcError(setErr, setRes, '사진 삭제에 실패했습니다.');
            console.error('[IntroPhoto] owner_set_intro_photo delete failed:', setErr, setRes);
            throw new Error(detailedMsg);
          }

          if (setRes.previous_image_url) {
            const cfg = resolveSupabaseConnectionConfig();
            const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
            const { error: removeErr } = await supabaseClient.storage.from(bucketName).remove([setRes.previous_image_url]);
            if (removeErr) {
              console.warn('[IntroPhoto] Storage file removal warning:', removeErr);
              showToast(`⚠️ 사진 설정은 해제되었으나 Storage 파일 삭제에 실패했습니다: ${removeErr.message}. 관리자 설정에서 [잔여 파일 삭제]로 다시 시도해 주세요.`, 6000);
            } else {
              await supabaseClient.rpc('owner_confirm_intro_deleted', {
                p_campaign_id: currentCampaignId,
                p_session_token: token,
                p_deleted_path: setRes.previous_image_url
              });
            }
          }
        } catch (photoErr) {
          console.error('[IntroPhoto] Photo delete caught error:', photoErr);
          urlError.textContent = `사진 삭제 중 오류: ${photoErr.message}`;
          urlError.hidden = false;
          return;
        }
      } else if (introFitVal !== (state.campaign.introImageFit || 'cover') && state.campaign.introImageUrl) {
        if (token) {
          const { data: setRes, error: setErr } = await supabaseClient.rpc('owner_set_intro_photo', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_object_path: state.campaign.introImageUrl,
            p_intro_image_fit: introFitVal
          });
          if (setErr || (setRes && !setRes.ok)) {
            console.warn('[IntroPhoto] Fit update warning:', setErr || setRes);
            const detailedMsg = formatSupabaseRpcError(setErr, setRes, '맞춤 방식 변경 실패');
            showToast(`⚠️ 액자 맞춤 방식 변경 경고: ${detailedMsg}`, 6000);
          }
        }
      }

      await fetchCampaignFromSupabase(currentCampaignId, true);
    } else {
      let finalIntroUrl = state.campaign.introImageUrl || '';
      if (profileSelectedIntroFile) {
        const reader = new FileReader();
        finalIntroUrl = await new Promise((resolve) => {
          reader.onload = (ev) => resolve(ev.target.result);
          reader.readAsDataURL(profileSelectedIntroFile);
        });
      } else if (profileIntroPhotoMarkedForDelete) {
        finalIntroUrl = '';
      }

      state.campaign = {
        ...state.campaign,
        hostName,
        emoji,
        birthdayDate,
        headline,
        subtitle,
        bio,
        bankName,
        bankAccount,
        kakaoRemitUrl: cleanKakao,
        tossRemitUrl: cleanToss,
        eventType,
        introMessage: customMsg,
        introImageUrl: finalIntroUrl,
        introImageFit: finalIntroUrl ? introFitVal : 'cover'
      };
      saveCurrentStateToLocalMultiDb();
      renderApp();
    }

    updateRemitBoxState();
    closeProfileModal();
    showToast('펀딩 프로필 및 인트로 사진 설정이 저장되었습니다!');
  }

  // =========================================================================
  // 9. MODAL 5: FUNDING OWNER PASSWORD LOGIN
  // =========================================================================
  function openAdminAuthModal() {
    const cfg = resolveSupabaseConnectionConfig();
    const urlInput = document.getElementById('quickSupabaseUrlInput');
    if (urlInput) urlInput.value = cfg.url || '';
    const keyInput = document.getElementById('quickSupabaseAnonKeyInput');
    if (keyInput) keyInput.value = cfg.anonKey || '';
    const bucketInput = document.getElementById('quickSupabaseBucketInput');
    if (bucketInput) bucketInput.value = cfg.bucket || DEFAULT_BUCKET_NAME;

    const authErr = document.getElementById('adminAuthErrorMsg');
    if (authErr) authErr.hidden = true;
    const sbErr = document.getElementById('supabaseConnectErrorMsg');
    if (sbErr) sbErr.hidden = true;
    const pwdInput = document.getElementById('adminPasswordInput');
    if (pwdInput) pwdInput.value = '';

    updateAdminModeUI();

    const backdrop = document.getElementById('adminAuthModalBackdrop');
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.setAttribute('aria-hidden', 'false');
    }
  }

  function closeAdminAuthModal() {
    const backdrop = document.getElementById('adminAuthModalBackdrop');
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  // =========================================================================
  // FIND MY FUNDING MODAL CONTROLS & RECOVERY
  // =========================================================================
  function openFindFundingModal(initialTab = 'my-created') {
    closeMobileDrawer();
    const backdrop = document.getElementById('findFundingModalBackdrop');
    if (!backdrop) return;

    switchFindFundingTab(initialTab);
    renderMyCreatedFundingsList();

    // Reset recovery lookup form
    const lookupInp = document.getElementById('recoveryCodeLookupInput');
    if (lookupInp) lookupInp.value = '';
    const lookupErr = document.getElementById('recoveryLookupErrorMsg');
    if (lookupErr) lookupErr.hidden = true;
    const resultCard = document.getElementById('recoveryResultCard');
    if (resultCard) resultCard.hidden = true;

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeFindFundingModal() {
    const backdrop = document.getElementById('findFundingModalBackdrop');
    if (!backdrop) return;
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function switchFindFundingTab(tabKey) {
    const tabMy = document.getElementById('tabMyCreatedFundings');
    const tabRc = document.getElementById('tabRecoveryCodeLookup');
    const panelMy = document.getElementById('panelMyCreatedFundings');
    const panelRc = document.getElementById('panelRecoveryCodeLookup');

    if (tabKey === 'recovery' || tabKey === 'recovery-code') {
      if (tabMy) {
        tabMy.classList.remove('active');
        tabMy.setAttribute('aria-selected', 'false');
      }
      if (tabRc) {
        tabRc.classList.add('active');
        tabRc.setAttribute('aria-selected', 'true');
      }
      if (panelMy) panelMy.hidden = true;
      if (panelRc) panelRc.hidden = false;
    } else {
      if (tabRc) {
        tabRc.classList.remove('active');
        tabRc.setAttribute('aria-selected', 'false');
      }
      if (tabMy) {
        tabMy.classList.add('active');
        tabMy.setAttribute('aria-selected', 'true');
      }
      if (panelRc) panelRc.hidden = true;
      if (panelMy) panelMy.hidden = false;
      renderMyCreatedFundingsList();
    }
  }

  function renderMyCreatedFundingsList() {
    const container = document.getElementById('myFundingsListContainer');
    const emptyState = document.getElementById('myFundingsEmptyState');
    if (!container || !emptyState) return;

    const list = getMyCreatedFundings();

    if (list.length === 0) {
      container.innerHTML = '';
      container.hidden = true;
      emptyState.hidden = false;
      return;
    }

    container.hidden = false;
    emptyState.hidden = true;

    container.innerHTML = list
      .map((item) => {
        const shareUrl = buildCampaignShareUrl(item.id);
        const evCfg = EVENT_TYPE_CONFIG[item.eventType] || EVENT_TYPE_CONFIG.general;
        const emoji = evCfg.emoji || '🎁';
        const formattedDate = item.createdAt ? new Date(item.createdAt).toLocaleDateString('ko-KR') : '';

        return `
          <div class="my-funding-card" data-campaign-id="${escapeHtml(item.id)}">
            <div class="my-funding-title-row">
              <span class="my-funding-name">
                <span>${emoji}</span>
                <span>${escapeHtml(item.hostName)}님의 펀딩</span>
              </span>
              <span class="my-funding-meta">${formattedDate ? escapeHtml(formattedDate) : ''}</span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-secondary); line-height: 1.4;">
              ${escapeHtml(item.headline || '')}
            </div>
            <div class="my-funding-actions-row">
              <span class="my-funding-id-text">ID: ${escapeHtml(item.id)}</span>
              <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                <button type="button" class="btn-subtle btn-xs" data-action="remove-my-funding" data-campaign-id="${escapeHtml(item.id)}">
                  기기에서 삭제
                </button>
                <button type="button" class="btn-secondary btn-xs" data-action="copy-my-funding" data-share-url="${escapeHtml(shareUrl)}">
                  🔗 링크 복사
                </button>
                <button type="button" class="btn-primary btn-xs" data-action="go-my-funding" data-campaign-id="${escapeHtml(item.id)}">
                  👉 바로가기
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function handleRecoveryCodeLookupSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('recoveryCodeLookupInput');
    const errEl = document.getElementById('recoveryLookupErrorMsg');
    const resultCard = document.getElementById('recoveryResultCard');
    const submitBtn = document.getElementById('recoveryLookupSubmitBtn');

    if (!input || !errEl || !resultCard) return;

    errEl.hidden = true;
    resultCard.hidden = true;

    const rawCode = input.value.trim();
    if (!rawCode) {
      errEl.textContent = '안전 복구 코드를 입력해 주세요.';
      errEl.hidden = false;
      input.focus();
      return;
    }

    try {
      submitBtn.disabled = true;
      submitBtn.textContent = '🔍 펀딩 찾는 중...';

      let foundCampaign = null;

      if (isCloudConnected && supabaseClient) {
        const { data, error } = await supabaseClient.rpc('lookup_campaign_by_recovery_code', {
          p_recovery_code: rawCode
        });

        if (error || !data || !data.ok) {
          throw new Error((data && data.message) || (error && error.message) || '일치하는 펀딩을 찾을 수 없습니다.');
        }
        foundCampaign = data;
      } else {
        // Local mode fallback
        const cleanUpper = rawCode.toUpperCase();
        const localDb = loadLocalMultiDb();
        let matchedId = null;

        Object.keys(localDb.campaigns || {}).forEach((cid) => {
          const rec = localDb.campaigns[cid];
          if (rec && rec.recoveryCode && rec.recoveryCode.toUpperCase() === cleanUpper) {
            matchedId = cid;
          }
        });

        if (!matchedId) {
          throw new Error('일치하는 펀딩을 찾을 수 없습니다. 복구 코드를 확인해 주세요.');
        }

        const camp = localDb.campaigns[matchedId].campaign;
        foundCampaign = {
          campaign_id: matchedId,
          host_name: camp.hostName,
          event_type: camp.eventType,
          headline: camp.headline,
          created_at: camp.createdAt || new Date().toISOString()
        };
      }

      if (!foundCampaign || !foundCampaign.campaign_id) {
        throw new Error('펀딩 정보를 불러올 수 없습니다.');
      }

      const campaignId = foundCampaign.campaign_id;
      const hostName = foundCampaign.host_name || '주인공';
      const eventType = foundCampaign.event_type || 'general';
      const headline = foundCampaign.headline || `${hostName}님의 선물 펀딩`;
      const shareUrl = buildCampaignShareUrl(campaignId);

      // Automatically register to this device's created fundings!
      addMyCreatedFunding({
        id: campaignId,
        hostName,
        eventType,
        headline,
        createdAt: foundCampaign.created_at || new Date().toISOString()
      });

      // Populate result
      document.getElementById('recoveryResultTitle').textContent = `${hostName}님의 선물 펀딩`;
      document.getElementById('recoveryResultMeta').textContent = `고유 ID: ${campaignId} · ${headline}`;
      document.getElementById('recoveryResultUrlInput').value = shareUrl;

      const copyBtn = document.getElementById('recoveryCopyUrlBtn');
      if (copyBtn) {
        copyBtn.onclick = () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(() => {
              showToast('🔗 펀딩 링크가 복사되었습니다!');
            });
          } else {
            showToast(`주소: ${shareUrl}`);
          }
        };
      }

      const goBtn = document.getElementById('recoveryGoFundingBtn');
      if (goBtn) {
        goBtn.onclick = () => {
          closeFindFundingModal();
          navigateToFunding(campaignId);
        };
      }

      resultCard.hidden = false;
      showToast('🎉 펀딩을 성공적으로 찾았습니다! 이 기기 목록에도 등록되었습니다.');
    } catch (err) {
      errEl.textContent = err.message || '펀딩 조회에 실패했습니다.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔍 펀딩 주소 찾기';
    }
  }

  async function handleSupabaseConnectSubmit(e) {
    e.preventDefault();
    const rawUrl = document.getElementById('quickSupabaseUrlInput').value.trim();
    const rawKey = document.getElementById('quickSupabaseAnonKeyInput').value.trim();
    const rawBucket = document.getElementById('quickSupabaseBucketInput').value.trim() || DEFAULT_BUCKET_NAME;
    const errEl = document.getElementById('supabaseConnectErrorMsg');
    const btn = document.getElementById('saveSupabaseConnectBtn');

    errEl.hidden = true;

    const validUrl = normalizeSupabaseProjectUrl(rawUrl);
    if (!validUrl) {
      errEl.textContent = '유효한 Supabase Project URL(https://xxxx.supabase.co)을 입력해 주세요.';
      errEl.hidden = false;
      return;
    }
    document.getElementById('quickSupabaseUrlInput').value = validUrl;
    if (!rawKey || rawKey.length < 15) {
      errEl.textContent = '유효한 Supabase Publishable Key (또는 Anon Public Key)를 입력해 주세요.';
      errEl.hidden = false;
      return;
    }
    if (isForbiddenServiceRoleKey(rawKey)) {
      errEl.textContent = '보안 경고: Secret key(sb_secret_...) 또는 service_role 키는 프런트엔드에서 절대 사용할 수 없습니다.';
      errEl.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = '연결 확인 중...';

    saveSupabaseConnectionConfig(validUrl, rawKey, rawBucket);
    await initSupabaseAndRoute();

    btn.disabled = false;
    btn.textContent = '☁️ 개발용 DB 연결 및 동기화';

    if (isCloudConnected) {
      showToast('☁️ 새 개발용 Supabase 데이터베이스에 연결되었습니다!');
    } else {
      errEl.textContent =
        lastSupabaseSyncError ||
        'Supabase 데이터베이스 연결 중 오류가 발생했습니다. supabase_schema.sql 실행 여부를 확인해 주세요.';
      errEl.hidden = false;
    }
  }

  async function handleAdminLoginSubmit(e) {
    e.preventDefault();
    if (!currentCampaignId) {
      showToast('먼저 개별 펀딩 페이지로 이동한 뒤 로그인해 주세요.');
      return;
    }

    const password = document.getElementById('adminPasswordInput').value.trim();
    const errEl = document.getElementById('adminAuthErrorMsg');
    const submitBtn = document.getElementById('adminLoginSubmitBtn');

    errEl.hidden = true;

    if (!password) {
      errEl.textContent = '이 펀딩의 관리 비밀번호를 입력해 주세요.';
      errEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '인증 중...';

    try {
      if (isCloudConnected && supabaseClient) {
        const { data, error } = await supabaseClient.rpc('login_campaign_owner', {
          p_campaign_id: currentCampaignId,
          p_password: password
        });

        if (error) {
          throw new Error(error.message);
        }
        if (!data || data.ok !== true || !data.session_token) {
          throw new Error((data && data.message) || '비밀번호 인증에 실패했습니다.');
        }

        saveOwnerSessionToken(currentCampaignId, data.session_token);
        isAdminAuthenticated = true;
      } else {
        // Local preview brute-force lock & password check
        const db = loadLocalMultiDb();
        const rec = db.campaigns[currentCampaignId];
        if (!rec) throw new Error('존재하지 않는 펀딩입니다.');

        if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
          const mins = Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 60000));
          throw new Error(`비밀번호 5회 연속 오류로 로그인이 잠겼습니다. 약 ${mins}분 후 다시 시도해 주세요.`);
        }

        const candidate = computeLocalHash(password, rec.ownerPwSalt);
        if (candidate !== rec.ownerPwHash) {
          rec.failedAttempts = (rec.failedAttempts || 0) + 1;
          if (rec.failedAttempts >= 5) {
            rec.failedAttempts = 0;
            rec.lockedUntil = Date.now() + 15 * 60 * 1000;
            saveLocalMultiDb(db);
            throw new Error('비밀번호를 5회 연속 틀려 15분간 관리 로그인이 잠겼습니다.');
          }
          saveLocalMultiDb(db);
          throw new Error(`관리 비밀번호가 일치하지 않습니다. (남은 시도 횟수: ${5 - rec.failedAttempts}회)`);
        }

        rec.failedAttempts = 0;
        rec.lockedUntil = 0;
        saveLocalMultiDb(db);

        const localToken = `local-owner-${currentCampaignId}-` + generateRandomHex(12);
        saveOwnerSessionToken(currentCampaignId, localToken);
        isAdminAuthenticated = true;
      }

      document.getElementById('adminPasswordInput').value = '';
      updateAdminModeUI();
      renderApp();

      // Register into this device's created fundings
      if (currentCampaignId && state.campaign) {
        addMyCreatedFunding({
          id: currentCampaignId,
          hostName: state.campaign.hostName,
          eventType: state.campaign.eventType,
          headline: state.campaign.headline,
          createdAt: new Date().toISOString()
        });
      }

      showToast(`🔓 ${state.campaign.hostName}님의 펀딩 주인 관리 모드로 전환되었습니다.`);
    } catch (err) {
      errEl.textContent = err.message || '관리 비밀번호 인증에 실패했습니다.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔐 펀딩 주인 로그인';
    }
  }

  async function handleAdminLogout() {
    const token = getStoredOwnerSessionToken(currentCampaignId);
    if (isCloudConnected && supabaseClient && currentCampaignId && token) {
      try {
        await supabaseClient.rpc('logout_campaign_owner', {
          p_campaign_id: currentCampaignId,
          p_session_token: token
        });
      } catch (e) {
        // Ignore
      }
    }
    saveOwnerSessionToken(currentCampaignId, '');
    isAdminAuthenticated = false;
    updateAdminModeUI();
    renderApp();
    showToast('펀딩 주인 관리 모드에서 로그아웃되었습니다.');
  }

  function copyCurrentFundingShareUrl() {
    if (!currentCampaignId) return;
    const shareUrl = buildCampaignShareUrl(currentCampaignId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast(`🔗 펀딩 공유 URL이 복사되었습니다! (${shareUrl})`);
      }).catch(() => {
        showToast(`공유 주소: ${shareUrl}`);
      });
    } else {
      showToast(`공유 주소: ${shareUrl}`);
    }
  }

  function exportCampaignJson() {
    if (!requireAdminPermission('데이터 백업')) return;
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateTag = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `bday-funding-${currentCampaignId}-${dateTag}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('내 펀딩 데이터가 JSON 파일로 백업되었습니다.');
  }

  async function resetAllContributionsClean() {
    if (!requireAdminPermission('펀딩 내역 0원 초기화')) return;
    if (!window.confirm('이 펀딩에 등록된 참여 내역과 메시지를 모두 비우고 0원 상태로 초기화할까요? (다른 사용자의 펀딩이나 내 선물 목록은 유지됩니다)')) {
      return;
    }

    if (isCloudConnected && supabaseClient) {
      const token = getStoredOwnerSessionToken(currentCampaignId);
      const { error } = await supabaseClient.rpc('owner_reset_contributions', {
        p_campaign_id: currentCampaignId,
        p_session_token: token
      });
      if (error) {
        showToast(`초기화 실패: ${error.message}`);
        return;
      }
      await fetchCampaignFromSupabase(currentCampaignId, true);
    } else {
      state.contributions = [];
      state.replies = [];
      saveCurrentStateToLocalMultiDb();
      renderApp();
    }
    closeMobileDrawer();
    showToast('이 펀딩의 참여 내역이 0원으로 초기화되었습니다.');
  }

  // =========================================================================
  // 10. FULLSCREEN BIRTHDAY CELEBRATION INTRO ENGINE & COORDINATOR
  // =========================================================================
  let introAnimFrameId = null;
  let introTimers = [];
  let introFinished = false;
  let isIntroRunning = false;
  let pendingCelebrationGift = null;
  let celebrationTimer = null;

  function getIntroSeenKey() {
    return `bday_intro_seen_v2_${currentCampaignId || 'home'}`;
  }

  function isIntroActive() {
    const overlay = document.getElementById('birthdayIntroOverlay');
    const docEl = document.documentElement;
    return isIntroRunning || Boolean(overlay && !overlay.hidden && docEl.classList.contains('intro-active'));
  }

  function clearIntroTimersAndLoop() {
    introTimers.forEach((tid) => clearTimeout(tid));
    introTimers = [];
    if (introAnimFrameId) {
      cancelAnimationFrame(introAnimFrameId);
      introAnimFrameId = null;
    }
  }

  function finishBirthdayIntro() {
    if (introFinished) return;
    introFinished = true;

    try {
      if (currentCampaignId) {
        sessionStorage.setItem(getIntroSeenKey(), '1');
      }
    } catch (e) {
      // Ignore
    }

    const docEl = document.documentElement;
    const overlay = document.getElementById('birthdayIntroOverlay');

    docEl.classList.remove('intro-active');
    docEl.classList.add('intro-fading-out');

    const cleanupTid = setTimeout(() => {
      clearIntroTimersAndLoop();
      docEl.classList.remove('intro-fading-out');
      docEl.classList.add('intro-skipped');
      if (overlay) {
        overlay.hidden = true;
      }
      const canvas = document.getElementById('introFireworksCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      isIntroRunning = false;

      // ② 인트로 오버레이가 완전히 사라지고 종료 처리까지 완료
      // ③ 약 1초간 아무 축하 오버레이도 없이 대기
      clearTimeout(celebrationTimer);
      celebrationTimer = setTimeout(() => {
        // 인트로 재생 중 다시보기 요청이 있었다면 먼저 재생
        if (pendingCelebrationGift) {
          const g = pendingCelebrationGift;
          pendingCelebrationGift = null;
          playBunnyCelebration(g);
          return;
        }

        // 인트로 종료 후 첫 방문 안내 팝업 확인
        checkFirstVisitGuideOnLoad();
      }, 800);
    }, 660);
    introTimers.push(cleanupTid);
  }

  function startBirthdayIntroAnimation(forceReplay = false) {
    if (!currentCampaignId) {
      finishBirthdayIntro();
      return;
    }

    const docEl = document.documentElement;
    const overlay = document.getElementById('birthdayIntroOverlay');
    const canvas = document.getElementById('introFireworksCanvas');
    if (!overlay || !canvas) return;

    renderDynamicHostLabels();

    const prefersReducedMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!forceReplay) {
      let alreadySeen = false;
      try {
        alreadySeen = sessionStorage.getItem(getIntroSeenKey()) === '1';
      } catch (e) {
        alreadySeen = false;
      }

      if (alreadySeen || prefersReducedMotion) {
        docEl.classList.remove('intro-active', 'intro-fading-out');
        docEl.classList.add('intro-skipped');
        overlay.hidden = true;
        isIntroRunning = false;
        introFinished = true;

        clearTimeout(celebrationTimer);
        celebrationTimer = setTimeout(() => {
          if (pendingCelebrationGift) {
            const g = pendingCelebrationGift;
            pendingCelebrationGift = null;
            playBunnyCelebration(g);
            return;
          }
          checkFirstVisitGuideOnLoad();
        }, 500);
        return;
      }
    }

    // Full Intro Start: Close any running celebration and reset coordinator flags
    closeBunnyCelebration();
    clearIntroTimersAndLoop();
    clearTimeout(celebrationTimer);
    introFinished = false;
    isIntroRunning = true;
    overlay.hidden = false;
    docEl.classList.remove('intro-skipped', 'intro-fading-out');
    docEl.classList.add('intro-active');

    const stage = overlay.querySelector('.intro-center-stage');
    if (stage) {
      stage.classList.remove('is-preparing');
      const clone = stage.cloneNode(true);
      stage.parentNode.replaceChild(clone, stage);
    }
    bindIntroEventTitles();

    if (prefersReducedMotion) {
      const tid = setTimeout(() => finishBirthdayIntro(), 1200);
      introTimers.push(tid);
      return;
    }

    const ctx = canvas.getContext('2d');
    const isMobile = window.innerWidth < 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let viewW = window.innerWidth;
    let viewH = window.innerHeight;

    function resizeIntroCanvas() {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      canvas.width = Math.floor(viewW * dpr);
      canvas.height = Math.floor(viewH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeIntroCanvas();

    const PALETTE = ['#C98691', '#A96575', '#E8C5CC', '#FFF9F7', '#F3B6C2', '#D6929E', '#E6B8A2'];
    const rockets = [];
    const particles = [];
    const shockRings = [];

    function pickColor() {
      return PALETTE[Math.floor(Math.random() * PALETTE.length)];
    }

    function createFireworkBurst(bx, by, scale = 1) {
      const baseCount = isMobile ? 34 : 52;
      const count = Math.round(baseCount * scale);

      shockRings.push({
        x: bx,
        y: by,
        radius: 4,
        maxRadius: (isMobile ? 65 : 95) * scale,
        alpha: 0.65,
        color: pickColor()
      });

      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.18;
        const speed = (2.2 + Math.random() * 5.4) * (isMobile ? 0.86 : 1) * scale;
        const randType = Math.random();
        let kind = 'spark';
        if (randType > 0.82) kind = 'heart';
        else if (randType > 0.66) kind = 'sparkle';

        particles.push({
          kind,
          x: bx,
          y: by,
          prevX: bx,
          prevY: by,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          drag: 0.962,
          gravity: kind === 'heart' ? 0.045 : 0.075,
          size: kind === 'heart' ? (6 + Math.random() * 4) : (2.4 + Math.random() * 2.8),
          color: pickColor(),
          alpha: 1,
          decay: 0.013 + Math.random() * 0.012,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.12
        });
      }
    }

    function launchRocket(startX, targetX, targetY, scale = 1) {
      const startY = viewH + 10;
      const flightFrames = isMobile ? 22 : 25;
      rockets.push({
        x: startX,
        y: startY,
        vx: (targetX - startX) / flightFrames,
        vy: (targetY - startY) / flightFrames,
        targetY,
        scale,
        color: '#C98691',
        trail: []
      });
    }

    function spawnCelebrationShower(count) {
      const actualCount = isMobile ? Math.round(count * 0.7) : count;
      for (let i = 0; i < actualCount; i++) {
        const r = Math.random();
        const kind = r < 0.36 ? 'heart' : r < 0.65 ? 'confetti' : 'sparkle';
        particles.push({
          kind,
          x: viewW * (0.06 + Math.random() * 0.88),
          y: -15 - Math.random() * (viewH * 0.35),
          prevX: 0,
          prevY: 0,
          vx: (Math.random() - 0.5) * 2.2,
          vy: 1.5 + Math.random() * 2.6,
          drag: 0.992,
          gravity: 0.025,
          size: kind === 'confetti' ? (6 + Math.random() * 5) : (6.5 + Math.random() * 4.5),
          color: pickColor(),
          alpha: 0.95,
          decay: 0.006 + Math.random() * 0.006,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.1,
          swayPhase: Math.random() * Math.PI * 2
        });
      }
    }

    function drawHeartShape(c, size) {
      const s = size * 0.55;
      c.beginPath();
      c.moveTo(0, s * 0.35);
      c.bezierCurveTo(0, -s * 0.4, -s * 1.1, -s * 0.4, -s * 1.1, s * 0.25);
      c.bezierCurveTo(-s * 1.1, s * 0.85, 0, s * 1.3, 0, s * 1.65);
      c.bezierCurveTo(0, s * 1.3, s * 1.1, s * 0.85, s * 1.1, s * 0.25);
      c.bezierCurveTo(s * 1.1, -s * 0.4, 0, -s * 0.4, 0, s * 0.35);
      c.closePath();
      c.fill();
    }

    function drawSparkleShape(c, size) {
      const outer = size;
      const inner = size * 0.32;
      c.beginPath();
      for (let i = 0; i < 8; i++) {
        const rad = i % 2 === 0 ? outer : inner;
        const ang = (i * Math.PI) / 4;
        const px = Math.cos(ang) * rad;
        const py = Math.sin(ang) * rad;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
    }

    introTimers.push(
      setTimeout(() => {
        launchRocket(viewW * 0.16, viewW * 0.22, viewH * 0.26, 0.95);
        launchRocket(viewW * 0.84, viewW * 0.78, viewH * 0.26, 0.95);
        spawnCelebrationShower(24);
      }, 220)
    );

    introTimers.push(
      setTimeout(() => {
        launchRocket(viewW * 0.5, viewW * 0.5, viewH * 0.19, 1.18);
        createFireworkBurst(viewW * 0.18, viewH * 0.42, 0.85);
        createFireworkBurst(viewW * 0.82, viewH * 0.42, 0.85);
      }, 780)
    );

    introTimers.push(
      setTimeout(() => {
        createFireworkBurst(viewW * 0.3, viewH * 0.24, 1.0);
        createFireworkBurst(viewW * 0.7, viewH * 0.24, 1.0);
        spawnCelebrationShower(28);
      }, 1450)
    );

    introTimers.push(
      setTimeout(() => {
        createFireworkBurst(viewW * 0.5, viewH * 0.22, 1.1);
        createFireworkBurst(viewW * 0.24, viewH * 0.34, 0.85);
        createFireworkBurst(viewW * 0.76, viewH * 0.34, 0.85);
      }, 2150)
    );

    introTimers.push(
      setTimeout(() => {
        finishBirthdayIntro();
      }, 3350)
    );

    function renderIntroFrame() {
      ctx.clearRect(0, 0, viewW, viewH);

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.trail.push({ x: r.x, y: r.y });
        if (r.trail.length > 6) r.trail.shift();

        r.x += r.vx;
        r.y += r.vy;

        if (r.trail.length > 1) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(r.trail[0].x, r.trail[0].y);
          for (let t = 1; t < r.trail.length; t++) {
            ctx.lineTo(r.trail[t].x, r.trail[t].y);
          }
          ctx.strokeStyle = 'rgba(201, 134, 145, 0.55)';
          ctx.lineWidth = 2.4;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.restore();
        }

        ctx.save();
        ctx.fillStyle = '#A96575';
        ctx.beginPath();
        ctx.arc(r.x, r.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (r.y <= r.targetY) {
          createFireworkBurst(r.x, r.y, r.scale);
          rockets.splice(i, 1);
        }
      }

      for (let i = shockRings.length - 1; i >= 0; i--) {
        const ring = shockRings[i];
        ring.radius += (ring.maxRadius - ring.radius) * 0.16;
        ring.alpha -= 0.032;

        if (ring.alpha <= 0.01) {
          shockRings.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, ring.alpha);
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.prevX = p.x;
        p.prevY = p.y;

        if (p.swayPhase !== undefined) {
          p.swayPhase += 0.06;
          p.x += p.vx + Math.sin(p.swayPhase) * 0.65;
        } else {
          p.x += p.vx;
        }
        p.y += p.vy;
        p.vx *= p.drag;
        p.vy = p.vy * p.drag + p.gravity;
        p.rotation += p.rotationSpeed;
        p.alpha -= p.decay;

        if (p.alpha <= 0.01 || p.y > viewH + 40) {
          particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;

        if (p.kind === 'spark') {
          ctx.lineWidth = p.size;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.prevX, p.prevY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.kind === 'heart') {
          ctx.translate(p.x, p.y);
          ctx.rotate(Math.sin(p.rotation) * 0.25);
          drawHeartShape(ctx, p.size);
        } else if (p.kind === 'sparkle') {
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          drawSparkleShape(ctx, p.size);
        } else {
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.fillRect(-p.size / 2, -p.size * 0.32, p.size, p.size * 0.64);
        }

        ctx.restore();
      }

      if (!introFinished) {
        introAnimFrameId = requestAnimationFrame(renderIntroFrame);
      }
    }

    introAnimFrameId = requestAnimationFrame(renderIntroFrame);
  }

  // =========================================================================
  // 11. CONFETTI CANVAS ENGINE & TOAST
  // =========================================================================
  let confettiAnimationId = null;
  let confettiParticles = [];

  function launchConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#C98691', '#A96575', '#E8C5CC', '#F4B8C4', '#D9A7B0', '#493B3E'];
    for (let i = 0; i < 75; i++) {
      confettiParticles.push({
        x: canvas.width * (0.2 + Math.random() * 0.6),
        y: canvas.height * 0.35,
        vx: (Math.random() - 0.5) * 13,
        vy: -(Math.random() * 11 + 5),
        size: Math.random() * 8 + 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 11,
        gravity: 0.26 + Math.random() * 0.1,
        opacity: 1
      });
    }

    if (!confettiAnimationId) {
      animateConfetti(canvas, ctx);
    }
  }

  function animateConfetti(canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    confettiParticles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.rotation += p.rotationSpeed;
      if (p.y > canvas.height * 0.75) {
        p.opacity -= 0.025;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
      ctx.restore();
    });

    confettiParticles = confettiParticles.filter((p) => p.opacity > 0 && p.y < canvas.height + 40);

    if (confettiParticles.length > 0) {
      confettiAnimationId = requestAnimationFrame(() => animateConfetti(canvas, ctx));
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confettiAnimationId = null;
    }
  }

  function showToast(message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.innerHTML = `<span>✨</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 3400);
  }

  // =========================================================================
  // 100% FUNDING GOAL ACHIEVEMENT SOFT BUNNY CELEBRATION CONTROLLER
  // =========================================================================
  let bunnyCelebrationTimer1 = null;
  let bunnyCelebrationTimer2 = null;
  let bunnyCelebrationTimer3 = null;

  function getGiftCelebrationKey(campaignId, giftId) {
    return `pf_celebrated_100_${campaignId}_${giftId}`;
  }

  function hasGiftBeenCelebrated(campaignId, giftId) {
    if (!campaignId || !giftId) return true;
    try {
      return localStorage.getItem(getGiftCelebrationKey(campaignId, giftId)) === '1';
    } catch (e) {
      return false;
    }
  }

  function markGiftCelebrated(campaignId, giftId) {
    if (!campaignId || !giftId) return;
    try {
      localStorage.setItem(getGiftCelebrationKey(campaignId, giftId), '1');
    } catch (e) {}
  }

  function findUncelebratedCompletedGift() {
    if (!currentCampaignId || !Array.isArray(state.gifts)) return null;
    return state.gifts.find((g) => {
      const m = getGiftMetrics(g);
      return m.isCompleted && !hasGiftBeenCelebrated(currentCampaignId, g.id);
    }) || null;
  }

  // =========================================================================
  // FANFARE SOUND EFFECT MANAGER (토끼 축하 팡파르 효과음)
  // =========================================================================
  const FANFARE_DEFAULT_VOLUME = 0.42;
  const CELEBRATION_SOUND_STORAGE_KEY = 'pf_celebration_sound_enabled';
  let fanfareFadeInterval = null;
  let lastPledgedGift = null;

  function getFanfareAudioUrl() {
    const filename = 'freesound_community-064034_fasching-fanfare-47823.mp3';
    try {
      let p = window.location.pathname;
      if (/\.html?$/i.test(p)) {
        p = p.substring(0, p.lastIndexOf('/') + 1);
      } else if (!p.endsWith('/')) {
        p += '/';
      }
      return new URL(filename, window.location.origin + p).href;
    } catch (e) {
      return './' + filename;
    }
  }

  function isCelebrationSoundEnabled() {
    try {
      return localStorage.getItem(CELEBRATION_SOUND_STORAGE_KEY) !== '0';
    } catch (e) {
      return true;
    }
  }

  function setCelebrationSoundEnabled(enabled) {
    try {
      localStorage.setItem(CELEBRATION_SOUND_STORAGE_KEY, enabled ? '1' : '0');
    } catch (e) {}
    updateSoundToggleButtonUI();
  }

  function updateSoundToggleButtonUI() {
    const btn = document.getElementById('bunnySoundToggleBtn');
    const icon = document.getElementById('bunnySoundIcon');
    const enabled = isCelebrationSoundEnabled();
    if (btn) {
      btn.classList.toggle('is-muted', !enabled);
      btn.setAttribute('aria-label', enabled ? '효과음 끄기' : '효과음 켜기');
      btn.title = enabled ? '효과음 끄기' : '효과음 켜기';
    }
    if (icon) {
      icon.textContent = enabled ? '🔊' : '🔇';
    }
  }

  function getFanfareAudioElement() {
    let audio = document.getElementById('bunnyFanfareAudio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'bunnyFanfareAudio';
      audio.preload = 'auto';
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    const targetUrl = getFanfareAudioUrl();
    if (!audio.src || !audio.src.includes('freesound_community-064034_fasching-fanfare-47823.mp3')) {
      audio.src = targetUrl;
      audio.load();
    }
    return audio;
  }

  function playCelebrationFanfare() {
    stopCelebrationFanfare(false);
    if (!isCelebrationSoundEnabled()) return;

    try {
      const audio = getFanfareAudioElement();
      audio.volume = FANFARE_DEFAULT_VOLUME;
      try {
        if (audio.readyState > 0) {
          audio.currentTime = 0;
        }
      } catch (seekErr) {}

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('Fanfare audio playing successfully:', audio.currentSrc);
          })
          .catch((err) => {
            // 브라우저의 자동재생 제한(Autoplay policy) 시 콘솔 로그 기록
            console.warn('Fanfare autoplay prevented by browser policy:', err);
          });
      }
    } catch (e) {
      console.warn('Error playing fanfare audio:', e);
    }
  }

  function stopCelebrationFanfare(smooth = true) {
    if (fanfareFadeInterval) {
      clearInterval(fanfareFadeInterval);
      fanfareFadeInterval = null;
    }
    const audio = document.getElementById('bunnyFanfareAudio');
    if (!audio) return;

    if (!smooth) {
      try {
        audio.pause();
        if (audio.readyState > 0) {
          audio.currentTime = 0;
        }
        audio.volume = FANFARE_DEFAULT_VOLUME;
      } catch (e) {}
      return;
    }

    // 약 350ms 동안 볼륨을 단계적으로 낮추며 자연스러운 페이드아웃
    const stepTime = 35;
    const stepDec = audio.volume / (350 / stepTime);
    fanfareFadeInterval = setInterval(() => {
      const a = document.getElementById('bunnyFanfareAudio');
      if (!a) {
        clearInterval(fanfareFadeInterval);
        fanfareFadeInterval = null;
        return;
      }
      if (a.volume > stepDec) {
        a.volume = Math.max(0, a.volume - stepDec);
      } else {
        clearInterval(fanfareFadeInterval);
        fanfareFadeInterval = null;
        try {
          a.pause();
          if (a.readyState > 0) {
            a.currentTime = 0;
          }
          a.volume = FANFARE_DEFAULT_VOLUME;
        } catch (e) {}
      }
    }, stepTime);
  }

  function closeBunnyCelebration() {
    clearTimeout(bunnyCelebrationTimer1);
    clearTimeout(bunnyCelebrationTimer2);
    clearTimeout(bunnyCelebrationTimer3);
    stopCelebrationFanfare(false);
    const overlay = document.getElementById('bunnyCelebrationOverlay');
    const dialog = document.getElementById('bunnyCelebrationDialog');
    if (dialog) dialog.classList.remove('is-animating', 'is-triumph', 'is-fading-out');
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  function playBunnyCelebration(gift = null) {
    if (gift) {
      lastPledgedGift = gift;
    }
    closeBunnyCelebration();

    const overlay = document.getElementById('bunnyCelebrationOverlay');
    const dialog = document.getElementById('bunnyCelebrationDialog');
    const badgeEl = document.getElementById('bunnyBubbleBadge');
    const titleEl = document.getElementById('bunnyBubbleTitle');
    const giftEl = document.getElementById('bunnyBubbleGift');
    if (!overlay || !dialog) return;

    if (badgeEl) {
      badgeEl.textContent = '✨ THANK YOU! ♡ ✨';
    }
    if (titleEl) {
      titleEl.textContent = '소중한 마음 고마워요! ♡';
    }
    if (giftEl) {
      giftEl.textContent = '후원 신청이 접수되었어요! 입금 확인 후 선물에 마음이 더해질 거예요.';
    }

    // Force CSS reflow so animation restarts cleanly from frame 0 every time
    dialog.classList.remove('is-animating', 'is-triumph', 'is-fading-out');
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');

    void dialog.offsetWidth;

    dialog.classList.add('is-animating');
    updateSoundToggleButtonUI();

    // 토끼가 화면에 나타나는 바로 그 순간 팡파르 재생 시작!
    playCelebrationFanfare();

    // 2.3s: Triumph victory pose (arms raised with drumsticks, laughing eyes, happy smile, confetti!)
    bunnyCelebrationTimer1 = setTimeout(() => {
      dialog.classList.add('is-triumph');
      launchConfetti();
    }, 2300);

    // 3.6s: Soft fade-out slide down & 토끼 퇴장 시 팡파르 소리도 자연스럽게 페이드아웃
    bunnyCelebrationTimer2 = setTimeout(() => {
      dialog.classList.add('is-fading-out');
      stopCelebrationFanfare(true);
    }, 3600);

    // 4.0s: Clean up and hide
    bunnyCelebrationTimer3 = setTimeout(() => {
      closeBunnyCelebration();
      // 후원 모달이 열려있는 중에는 첫 방문 가이드 팝업을 띄우지 않음
      const pledgeBackdrop = document.getElementById('pledgeModalBackdrop');
      const isPledgeModalOpen = pledgeBackdrop && !pledgeBackdrop.hidden;
      if (!isUserGuideDismissed() && !isIntroActive() && !isPledgeModalOpen) {
        setTimeout(() => {
          if (!isIntroActive()) openUserGuideModal();
        }, 400);
      }
    }, 4000);
  }

  function checkUncelebratedGiftsOnLoad() {
    // 100% 달성 조건과 토끼 자동 축하가 분리되었으므로 페이지 로드 시 자동 실행하지 않음
  }

  // =========================================================================
  // 11. FIRST-VISIT USER GUIDE MODAL (마음을 모아 선물해요! ♡)
  // =========================================================================
  const USER_GUIDE_DISMISSED_KEY = 'pf_user_guide_dismissed_v1';

  function isUserGuideDismissed() {
    try {
      return localStorage.getItem(USER_GUIDE_DISMISSED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setUserGuideDismissed(dismissed) {
    try {
      if (dismissed) {
        localStorage.setItem(USER_GUIDE_DISMISSED_KEY, '1');
      } else {
        localStorage.removeItem(USER_GUIDE_DISMISSED_KEY);
      }
    } catch (e) {}
  }

  function openUserGuideModal() {
    const backdrop = document.getElementById('userGuideModalBackdrop');
    const checkbox = document.getElementById('guideDontShowCheckbox');
    if (!backdrop) return;
    if (checkbox) {
      checkbox.checked = isUserGuideDismissed();
    }
    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeUserGuideModal() {
    const backdrop = document.getElementById('userGuideModalBackdrop');
    const checkbox = document.getElementById('guideDontShowCheckbox');
    if (checkbox && checkbox.checked) {
      setUserGuideDismissed(true);
    } else {
      setUserGuideDismissed(false);
    }
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
    }
    // After guide is closed, check for any uncelebrated completed gifts
    setTimeout(() => {
      checkUncelebratedGiftsOnLoad();
    }, 350);
  }

  function checkFirstVisitGuideOnLoad() {
    if (isUserGuideDismissed()) {
      checkUncelebratedGiftsOnLoad();
      return;
    }
    setTimeout(() => {
      openUserGuideModal();
    }, 450);
  }

  function closeMobileDrawer() {
    const drawer = document.getElementById('mobileNavDrawer');
    const toggleBtn = document.getElementById('mobileMenuToggleBtn');
    if (drawer) drawer.hidden = true;
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
  }

  // =========================================================================
  // 12. EVENT LISTENERS BINDING
  // =========================================================================
  function bindEvents() {
    // Initialize default birthday input on Create Funding screen
    const createBdayInput = document.getElementById('createBirthdayDateInput');
    if (createBdayInput && !createBdayInput.value) {
      createBdayInput.value = getTodayDateString();
    }

    // Browser history popstate support
    window.addEventListener('popstate', () => {
      routeToCurrentView(false);
    });

    // Recalculate gift description truncation toggles on window resize
    let giftDescResizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(giftDescResizeTimer);
      giftDescResizeTimer = setTimeout(() => {
        updateGiftDescToggles();
      }, 150);
    });

    // Brand Home click: scroll to top if on a funding page, or go to home if on create view
    document.getElementById('brandHome').addEventListener('click', () => {
      closeMobileDrawer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Go to Create New Funding Buttons
    const goCreateTriggers = [
      'topCreateNewFundingBtn',
      'dropdownGoCreateBtn',
      'mobileGoCreateFundingBtn',
      'footerGoCreateBtn'
    ];
    goCreateTriggers.forEach((btnId) => {
      const el = document.getElementById(btnId);
      if (el) {
        el.addEventListener('click', () => {
          document.getElementById('dataDropdownMenu').hidden = true;
          closeMobileDrawer();
          document.getElementById('createFundingFormBox').hidden = false;
          document.getElementById('createdUrlSuccessBox').hidden = true;
          navigateToHome();
        });
      }
    });

    // First-Visit & Manual Guide Buttons
    const guideTriggers = ['topGuideBtn', 'dropdownGuideBtn', 'mobileGuideBtn', 'footerGuideBtn'];
    guideTriggers.forEach((btnId) => {
      const el = document.getElementById(btnId);
      if (el) {
        el.addEventListener('click', () => {
          const menu = document.getElementById('dataDropdownMenu');
          if (menu) menu.hidden = true;
          closeMobileDrawer();
          openUserGuideModal();
        });
      }
    });

    const closeGuideBtn = document.getElementById('closeUserGuideModalBtn');
    if (closeGuideBtn) {
      closeGuideBtn.addEventListener('click', closeUserGuideModal);
    }
    const guideStartBtn = document.getElementById('guideStartBtn');
    if (guideStartBtn) {
      guideStartBtn.addEventListener('click', closeUserGuideModal);
    }

    // Share Current Funding URL Buttons
    const shareTriggers = [
      'topShareUrlBtn',
      'dropdownShareFundingBtn',
      'mobileShareUrlBtn',
      'heroShareFundingBtn',
      'adminCopyFundingUrlBtn'
    ];
    shareTriggers.forEach((btnId) => {
      const el = document.getElementById(btnId);
      if (el) {
        el.addEventListener('click', () => {
          document.getElementById('dataDropdownMenu').hidden = true;
          closeMobileDrawer();
          copyCurrentFundingShareUrl();
        });
      }
    });

    // Create Funding Form & Issued URL Box Events
    document.getElementById('createFundingForm').addEventListener('submit', handleCreateFundingSubmit);

    const createEventTypeSel = document.getElementById('createEventTypeSelect');
    const createEventCustomBox = document.getElementById('createEventCustomBox');
    const createEmojiSel = document.getElementById('createEmojiSelect');
    const createHeadlineInp = document.getElementById('createHeadlineInput');
    const createHostNameInp = document.getElementById('createHostNameInput');

    if (createEventTypeSel) {
      createEventTypeSel.addEventListener('change', () => {
        const val = createEventTypeSel.value;
        if (createEventCustomBox) {
          createEventCustomBox.hidden = val !== 'custom';
        }
        const cfg = EVENT_TYPE_CONFIG[val] || EVENT_TYPE_CONFIG.general;
        if (createEmojiSel && cfg) {
          createEmojiSel.value = cfg.emoji;
        }
        const currentName = (createHostNameInp && createHostNameInp.value.trim()) || '{이름}';
        if (createHeadlineInp) {
          createHeadlineInp.placeholder = `미입력 시 '${cfg.defaultHeadline(currentName)}'`;
        }
      });
    }

    if (createHostNameInp) {
      createHostNameInp.addEventListener('input', () => {
        const selVal = (createEventTypeSel && createEventTypeSel.value) || '';
        const cfg = (selVal && EVENT_TYPE_CONFIG[selVal]) ? EVENT_TYPE_CONFIG[selVal] : EVENT_TYPE_CONFIG.general;
        const currentName = createHostNameInp.value.trim() || '{이름}';
        if (createHeadlineInp) {
          createHeadlineInp.placeholder = `미입력 시 '${cfg.defaultHeadline(currentName)}'`;
        }
      });
    }

    document.getElementById('copyIssuedUrlBtn').addEventListener('click', () => {
      const urlVal = document.getElementById('issuedShareUrlInput').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urlVal).then(() => {
          showToast('🔗 발급된 공유 URL이 클립보드에 복사되었습니다!');
        });
      }
    });

    document.getElementById('copyIssuedUrlAgainBtn').addEventListener('click', () => {
      const urlVal = document.getElementById('issuedShareUrlInput').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urlVal).then(() => {
          showToast('📋 공유 링크가 복사되었습니다! 친구들에게 공유해 보세요.');
        });
      }
    });

    document.getElementById('goMyCreatedFundingBtn').addEventListener('click', () => {
      if (lastCreatedCampaignId) {
        navigateToFunding(lastCreatedCampaignId, true);
      }
    });

    const copyRcBtn = document.getElementById('copyRecoveryCodeBtn');
    if (copyRcBtn) {
      copyRcBtn.addEventListener('click', () => {
        const rc = (document.getElementById('issuedRecoveryCodeText')?.textContent || '').trim();
        if (!rc || rc === '---') return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(rc).then(() => {
            showToast('🔑 복구 코드가 복사되었습니다! 안전한 곳에 메모해 두세요.');
          });
        }
      });
    }

    // Find My Funding Triggers & Modal Events
    const findFundingTriggers = [
      'topFindFundingBtn',
      'dropdownFindFundingBtn',
      'mobileFindFundingBtn',
      'heroFindFundingBtn'
    ];
    findFundingTriggers.forEach((btnId) => {
      const el = document.getElementById(btnId);
      if (el) {
        el.addEventListener('click', () => {
          const menu = document.getElementById('dataDropdownMenu');
          if (menu) menu.hidden = true;
          closeMobileDrawer();
          openFindFundingModal('my-created');
        });
      }
    });

    const closeFindFundingModalBtn = document.getElementById('closeFindFundingModalBtn');
    if (closeFindFundingModalBtn) {
      closeFindFundingModalBtn.addEventListener('click', closeFindFundingModal);
    }
    const closeFindFundingFooterBtn = document.getElementById('closeFindFundingFooterBtn');
    if (closeFindFundingFooterBtn) {
      closeFindFundingFooterBtn.addEventListener('click', closeFindFundingModal);
    }

    const tabMyCreated = document.getElementById('tabMyCreatedFundings');
    if (tabMyCreated) {
      tabMyCreated.addEventListener('click', () => switchFindFundingTab('my-created'));
    }
    const tabRecovery = document.getElementById('tabRecoveryCodeLookup');
    if (tabRecovery) {
      tabRecovery.addEventListener('click', () => switchFindFundingTab('recovery-code'));
    }

    // Delegated actions inside myFundingsListContainer
    const myFundingsContainer = document.getElementById('myFundingsListContainer');
    if (myFundingsContainer) {
      myFundingsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const cid = btn.getAttribute('data-campaign-id') || btn.getAttribute('data-cid');
        if (!cid && action !== 'copy-my-funding') return;

        if (action === 'go-my-funding' || action === 'go') {
          closeFindFundingModal();
          navigateToFunding(cid, true);
        } else if (action === 'copy-my-funding' || action === 'copy') {
          const url = btn.getAttribute('data-share-url') || buildCampaignShareUrl(cid);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
              showToast('🔗 펀딩 링크가 클립보드에 복사되었습니다!');
            });
          }
        } else if (action === 'remove-my-funding' || action === 'remove') {
          if (confirm('이 기기의 목록에서 삭제하시겠습니까?\n(펀딩 자체나 후원 데이터는 삭제되지 않습니다)')) {
            removeMyCreatedFunding(cid);
            renderMyCreatedFundingsList();
            showToast('목록에서 삭제되었습니다.');
          }
        }
      });
    }

    // Recovery Code Lookup Form
    const recoveryLookupForm = document.getElementById('recoveryLookupForm');
    if (recoveryLookupForm) {
      recoveryLookupForm.addEventListener('submit', handleRecoveryCodeLookupSubmit);
    }

    // Create Funding Intro Photo Preview & Crop Events
    const createPhotoInput = document.getElementById('createIntroPhotoInput');
    const createPreviewWrap = document.getElementById('createIntroPhotoPreviewWrap');
    const createPreviewImg = document.getElementById('createIntroPhotoPreviewImg');
    const createFitSelect = document.getElementById('createIntroPhotoFitSelect');
    const createCancelBtn = document.getElementById('createIntroPhotoCancelBtn');
    const createRecropBtn = document.getElementById('createIntroPhotoRecropBtn');

    if (createPhotoInput) {
      createPhotoInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          if (createPreviewWrap && !createIntroPhotoCropBlob) createPreviewWrap.hidden = true;
          return;
        }
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
          showToast('⚠️ 사진 크기는 최대 5MB까지 가능합니다.');
          createPhotoInput.value = '';
          if (createPreviewWrap && !createIntroPhotoCropBlob) createPreviewWrap.hidden = true;
          return;
        }
        createIntroPhotoRawSource = file;
        openPhotoCropModal({
          source: file,
          initialAspect: 1,
          originalMime: file.type || 'image/jpeg',
          onApply: ({ blob, dataUrl }) => {
            createIntroPhotoCropBlob = blob;
            createIntroPhotoCropDataUrl = dataUrl;
            if (createPreviewImg) {
              createPreviewImg.src = dataUrl;
              createPreviewImg.className = `intro-preview-thumbnail fit-${(createFitSelect && createFitSelect.value === 'contain') ? 'contain' : 'cover'}`;
            }
            if (createPreviewWrap) createPreviewWrap.hidden = false;
          },
          onCancel: () => {
            if (!createIntroPhotoCropBlob) {
              createPhotoInput.value = '';
              if (createPreviewWrap) createPreviewWrap.hidden = true;
            }
          }
        });
      });
    }

    if (createRecropBtn) {
      createRecropBtn.addEventListener('click', () => {
        const src = createIntroPhotoRawSource || createIntroPhotoCropDataUrl;
        if (!src) return;
        openPhotoCropModal({
          source: src,
          initialAspect: 1,
          onApply: ({ blob, dataUrl }) => {
            createIntroPhotoCropBlob = blob;
            createIntroPhotoCropDataUrl = dataUrl;
            if (createPreviewImg) {
              createPreviewImg.src = dataUrl;
            }
            if (createPreviewWrap) createPreviewWrap.hidden = false;
          }
        });
      });
    }

    if (createFitSelect && createPreviewImg) {
      createFitSelect.addEventListener('change', () => {
        createPreviewImg.className = `intro-preview-thumbnail fit-${createFitSelect.value === 'contain' ? 'contain' : 'cover'}`;
      });
    }

    if (createCancelBtn && createPhotoInput) {
      createCancelBtn.addEventListener('click', () => {
        createPhotoInput.value = '';
        createIntroPhotoRawSource = null;
        createIntroPhotoCropBlob = null;
        createIntroPhotoCropDataUrl = '';
        if (createPreviewWrap) createPreviewWrap.hidden = true;
        if (createPreviewImg) createPreviewImg.src = '';
      });
    }

    // Jump to Existing Funding ID Form & Recent Fundings Clicks
    document.getElementById('jumpFundingForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = document.getElementById('jumpFundingIdInput').value;
      const cid = extractCampaignIdFromInput(raw);
      if (!cid) {
        showToast('이동할 펀딩의 고유 ID 또는 공유 URL을 입력해 주세요.');
        return;
      }
      navigateToFunding(cid, true);
    });

    // Visibility Change Listener for Instant Sync
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isCloudConnected && currentCampaignId) {
        fetchCampaignFromSupabase(currentCampaignId, true);
      }
    });

    // Mobile Hamburger Menu Toggle
    const mobileMenuBtn = document.getElementById('mobileMenuToggleBtn');
    const mobileDrawer = document.getElementById('mobileNavDrawer');
    mobileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = mobileDrawer.hidden;
      mobileDrawer.hidden = !willOpen;
      mobileMenuBtn.setAttribute('aria-expanded', String(willOpen));
    });

    document.querySelectorAll('[data-close-drawer="true"]').forEach((link) => {
      link.addEventListener('click', () => closeMobileDrawer());
    });

    // Top Header & Mobile Drawer Admin / Sync Buttons
    document.getElementById('cloudSyncStatusBtn').addEventListener('click', () => openAdminAuthModal());
    document.getElementById('openAdminAuthBtn').addEventListener('click', () => openAdminAuthModal());
    document.getElementById('dropdownAdminAuthBtn').addEventListener('click', () => {
      document.getElementById('dataDropdownMenu').hidden = true;
      openAdminAuthModal();
    });
    document.getElementById('mobileAdminAuthBtn').addEventListener('click', () => {
      closeMobileDrawer();
      openAdminAuthModal();
    });

    // Mobile Drawer Action Buttons
    document.getElementById('mobileAddGiftBtn').addEventListener('click', () => {
      closeMobileDrawer();
      openGiftModal();
    });
    document.getElementById('mobileRemitConfigBtn').addEventListener('click', () => {
      closeMobileDrawer();
      openProfileModal();
    });
    document.getElementById('mobileExportJsonBtn').addEventListener('click', () => {
      closeMobileDrawer();
      exportCampaignJson();
    });
    document.getElementById('mobileResetCleanBtn').addEventListener('click', resetAllContributionsClean);

    // Desktop Top Bar Owner Buttons
    document.getElementById('dropdownTossSettingBtn').addEventListener('click', () => {
      document.getElementById('dataDropdownMenu').hidden = true;
      openProfileModal();
    });
    document.getElementById('topAddGiftBtn').addEventListener('click', () => openGiftModal());

    // Data Dropdown Menu
    const dataMenuBtn = document.getElementById('dataMenuBtn');
    const dataDropdownMenu = document.getElementById('dataDropdownMenu');
    dataMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = dataDropdownMenu.hidden;
      dataDropdownMenu.hidden = !isHidden;
      dataMenuBtn.setAttribute('aria-expanded', String(isHidden));
    });

    document.addEventListener('click', (e) => {
      dataDropdownMenu.hidden = true;
      dataMenuBtn.setAttribute('aria-expanded', 'false');
      if (!mobileDrawer.hidden && !mobileDrawer.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
        closeMobileDrawer();
      }
    });

    document.getElementById('exportJsonBtn').addEventListener('click', exportCampaignJson);
    document.getElementById('resetCleanBtn').addEventListener('click', resetAllContributionsClean);

    // Pending Banner Jump Button
    document.getElementById('jumpToPendingBtn').addEventListener('click', () => {
      currentStatusFilter = 'pending';
      document.querySelectorAll('.status-filter-tab').forEach((t) => {
        t.classList.toggle('active', t.getAttribute('data-status-filter') === 'pending');
      });
      renderGuestbookSection();
    });

    // Hero Section Buttons
    document.getElementById('heroMainPledgeBtn').addEventListener('click', () => openPledgeModal());
    document.getElementById('heroAddGiftBtn').addEventListener('click', () => openGiftModal());
    document.getElementById('quickEditCampaignBtn').addEventListener('click', () => openProfileModal());
    document.getElementById('addGiftInlineBtn').addEventListener('click', () => openGiftModal());

    // Wishlist Filter & Sort
    document.querySelectorAll('.filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach((t) => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        currentGiftFilter = tab.getAttribute('data-filter') || 'all';
        renderWishlistSection();
      });
    });

    document.getElementById('giftSortSelect').addEventListener('change', (e) => {
      currentGiftSort = e.target.value;
      renderWishlistSection();
    });

    // Delegated Clicks on Wishlist Grid
    document.getElementById('wishlistGrid').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const giftId = btn.getAttribute('data-gift-id');

      if (action === 'toggle-desc') {
        const card = btn.closest('.gift-card');
        const descEl = card ? card.querySelector('.gift-desc') : null;
        if (!card || !descEl) return;

        const isCurrentlyExpanded = expandedGiftDescIds.has(giftId);
        if (isCurrentlyExpanded) {
          expandedGiftDescIds.delete(giftId);
          descEl.classList.remove('is-expanded');
          btn.setAttribute('aria-expanded', 'false');
          const textSpan = btn.querySelector('.desc-toggle-text');
          const arrowSpan = btn.querySelector('.desc-toggle-arrow');
          if (textSpan) textSpan.textContent = '전체보기';
          if (arrowSpan) arrowSpan.textContent = '▾';
        } else {
          expandedGiftDescIds.add(giftId);
          descEl.classList.add('is-expanded');
          btn.setAttribute('aria-expanded', 'true');
          const textSpan = btn.querySelector('.desc-toggle-text');
          const arrowSpan = btn.querySelector('.desc-toggle-arrow');
          if (textSpan) textSpan.textContent = '접기';
          if (arrowSpan) arrowSpan.textContent = '▴';
        }
        return;
      }

      if (action === 'open-pledge') {
        openPledgeModal(giftId);
      } else if (action === 'edit-gift') {
        openGiftModal(giftId);
      } else if (action === 'delete-gift') {
        if (!requireAdminPermission('위시리스트 선물 삭제')) return;
        if (window.confirm('이 선물을 위시리스트에서 삭제할까요?')) {
          if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
            const token = getStoredOwnerSessionToken(currentCampaignId);
            const { error } = await supabaseClient.rpc('owner_delete_gift', {
              p_campaign_id: currentCampaignId,
              p_session_token: token,
              p_gift_id: giftId
            });
            if (error) {
              showToast(`선물 삭제 실패: ${error.message}`);
              return;
            }
            await fetchCampaignFromSupabase(currentCampaignId, true);
          } else {
            state.gifts = state.gifts.filter((g) => g.id !== giftId);
            state.contributions = state.contributions.filter((c) => c.giftId !== giftId);
            saveCurrentStateToLocalMultiDb();
            renderApp();
          }
          showToast('선물이 삭제되었습니다.');
        }
      } else if (action === 'replay-gift-celebration') {
        const targetGift = state.gifts.find((g) => String(g.id || '').trim() === String(giftId || '').trim());
        if (targetGift) {
          if (isIntroActive()) {
            pendingCelebrationGift = targetGift;
            showToast('인트로가 끝난 후 축하 애니메이션이 재생됩니다 🐰');
            return;
          }
          playBunnyCelebration(targetGift);
        }
      }
    });

    // Guestbook Status Filter Tabs
    document.querySelectorAll('.status-filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.status-filter-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        currentStatusFilter = tab.getAttribute('data-status-filter') || 'all';
        renderGuestbookSection();
      });
    });

    document.getElementById('messageSearchInput').addEventListener('input', (e) => {
      currentMessageSearch = e.target.value;
      renderGuestbookSection();
    });

    document.getElementById('messageGiftFilter').addEventListener('change', (e) => {
      currentMessageGiftFilter = e.target.value;
      renderGuestbookSection();
    });

    document.getElementById('openMessageOnlyModalBtn').addEventListener('click', () => openPledgeModal());

    // Delegated Actions on Blessing Grid (Owner Approval / Unapproval / Delete + Public Cheer / Self Avatar Manage + Replies)
    document.getElementById('blessingGrid').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const pledgeId = btn.getAttribute('data-pledge-id');

      if (action === 'toggle-replies') {
        if (!pledgeId) return;
        if (openReplyThreadIds.has(pledgeId)) {
          openReplyThreadIds.delete(pledgeId);
        } else {
          openReplyThreadIds.add(pledgeId);
        }
        renderGuestbookSection();
        return;
      }

      if (action === 'open-reply-form') {
        if (!pledgeId) return;
        openReplyThreadIds.add(pledgeId);
        openReplyFormIds.add(pledgeId);
        renderGuestbookSection();
        const box = document.getElementById(`replyFormBox-${pledgeId}`);
        if (box) {
          box.hidden = false;
          const textarea = box.querySelector('.reply-content-input');
          if (textarea) textarea.focus();
        }
        return;
      }

      if (action === 'cancel-reply') {
        if (!pledgeId) return;
        openReplyFormIds.delete(pledgeId);
        renderGuestbookSection();
        return;
      }

      if (action === 'delete-reply') {
        const replyId = btn.getAttribute('data-reply-id');
        if (!replyId) return;
        if (!requireAdminPermission('답글 삭제')) return;
        if (window.confirm('이 답글을 삭제할까요?')) {
          if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
            const token = getStoredOwnerSessionToken(currentCampaignId);
            const { error } = await supabaseClient.rpc('owner_delete_reply', {
              p_campaign_id: currentCampaignId,
              p_session_token: token,
              p_reply_id: replyId
            });
            if (error) {
              showToast(`답글 삭제 실패: ${error.message}`);
              return;
            }
            await fetchCampaignFromSupabase(currentCampaignId, true);
          } else {
            state.replies = (state.replies || []).filter((r) => r.id !== replyId);
            saveCurrentStateToLocalMultiDb();
            renderGuestbookSection();
          }
          showToast('답글이 삭제되었습니다.');
        }
        return;
      }

      if (action === 'report-reply') {
        const replyId = btn.getAttribute('data-reply-id');
        if (!replyId) return;
        if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
          await supabaseClient.rpc('report_contribution_reply', {
            p_campaign_id: currentCampaignId,
            p_reply_id: replyId
          });
        }
        showToast('🚨 신고가 정상 접수되었습니다. 검토 후 조치됩니다.');
        return;
      }

      const target = pledgeId ? state.contributions.find((c) => c.id === pledgeId) : null;
      if (!target) return;

      if (action === 'approve-pledge') {
        if (!requireAdminPermission('입금 확인 승인')) return;
        const targetGiftBefore = state.gifts.find((g) => String(g.id || '').trim() === String(target.giftId || '').trim());
        const wasCompletedBefore = targetGiftBefore ? getGiftMetrics(targetGiftBefore).isCompleted : false;

        if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
          const token = getStoredOwnerSessionToken(currentCampaignId);
          const { error } = await supabaseClient.rpc('owner_set_contribution_status', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_contribution_id: pledgeId,
            p_status: 'approved'
          });
          if (error) {
            showToast(`입금 승인 실패: ${error.message}`);
            return;
          }
          await fetchCampaignFromSupabase(currentCampaignId, true);
        } else {
          target.status = 'approved';
          saveCurrentStateToLocalMultiDb();
          renderApp();
        }

        const targetGiftAfter = state.gifts.find((g) => String(g.id || '').trim() === String(target.giftId || '').trim()) || targetGiftBefore;
        const isCompletedNow = targetGiftAfter ? getGiftMetrics(targetGiftAfter).isCompleted : false;

        launchConfetti();
        showToast(`✅ ${target.senderName}님의 입금(${formatKRW(target.amount)})이 승인되어 달성률에 반영되었습니다!`);
      } else if (action === 'unapprove-pledge') {
        if (!requireAdminPermission('입금 승인 취소')) return;
        if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
          const token = getStoredOwnerSessionToken(currentCampaignId);
          const { error } = await supabaseClient.rpc('owner_set_contribution_status', {
            p_campaign_id: currentCampaignId,
            p_session_token: token,
            p_contribution_id: pledgeId,
            p_status: 'pending'
          });
          if (error) {
            showToast(`승인 취소 실패: ${error.message}`);
            return;
          }
          await fetchCampaignFromSupabase(currentCampaignId, true);
        } else {
          target.status = 'pending';
          saveCurrentStateToLocalMultiDb();
          renderApp();
        }
        showToast(`⏳ ${target.senderName}님의 내역이 '입금 확인 대기'로 변경되었습니다.`);
      } else if (action === 'manage-avatar') {
        openAvatarManageModal(pledgeId);
      } else if (action === 'cheer-pledge') {
        const alreadyCheered = cheeredIdsSet.has(pledgeId);
        const delta = alreadyCheered ? -1 : 1;

        if (alreadyCheered) {
          cheeredIdsSet.delete(pledgeId);
          target.cheers = Math.max(0, (Number(target.cheers) || 1) - 1);
          target.cheeredByMe = false;
        } else {
          cheeredIdsSet.add(pledgeId);
          target.cheers = (Number(target.cheers) || 0) + 1;
          target.cheeredByMe = true;
        }
        saveCheeredIds();
        renderGuestbookSection();

        if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
          await supabaseClient.rpc('increment_contribution_cheer', {
            p_contribution_id: pledgeId,
            p_delta: delta
          });
          await fetchCampaignFromSupabase(currentCampaignId, true);
        } else {
          saveCurrentStateToLocalMultiDb();
        }
      } else if (action === 'delete-pledge') {
        if (!requireAdminPermission('참여 내역 삭제')) return;
        if (window.confirm('입금이 확인되지 않았거나 취소된 후원 신청을 삭제하시겠습니까?\n삭제하시면 방명록과 펀딩 목록에서 완전히 제거됩니다.')) {
          if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
            const token = getStoredOwnerSessionToken(currentCampaignId);
            const { error } = await supabaseClient.rpc('owner_delete_contribution', {
              p_campaign_id: currentCampaignId,
              p_session_token: token,
              p_contribution_id: pledgeId
            });
            if (error) {
              showToast(`삭제 실패: ${error.message}`);
              return;
            }
            await fetchCampaignFromSupabase(currentCampaignId, true);
          } else {
            state.contributions = state.contributions.filter((c) => c.id !== pledgeId);
            saveCurrentStateToLocalMultiDb();
            renderApp();
          }
          showToast('내역이 삭제되었습니다.');
        }
      }
    });

    // Delegated Reply Form Submit on Blessing Grid
    document.getElementById('blessingGrid').addEventListener('submit', async (e) => {
      const form = e.target.closest('.reply-submit-form');
      if (!form) return;
      e.preventDefault();
      const pledgeId = form.getAttribute('data-pledge-id');
      if (!pledgeId) return;

      const authorInp = form.querySelector('.reply-author-input');
      const contentInp = form.querySelector('.reply-content-input');
      const submitBtn = form.querySelector('.btn-reply-submit');
      if (!authorInp || !contentInp) return;

      const author = authorInp.value.trim();
      const content = contentInp.value.trim();

      if (!author) {
        showToast('답글 작성자 닉네임을 입력해 주세요.');
        authorInp.focus();
        return;
      }
      if (author.length > 30) {
        showToast('닉네임은 최대 30자까지 입력 가능합니다.');
        authorInp.focus();
        return;
      }
      if (!content) {
        showToast('답글 내용을 입력해 주세요.');
        contentInp.focus();
        return;
      }
      if (content.length > 300) {
        showToast('답글 내용은 최대 300자까지 입력 가능합니다.');
        contentInp.focus();
        return;
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = '등록 중...';
        }

        if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
          const token = isAdminAuthenticated ? getStoredOwnerSessionToken(currentCampaignId) : '';
          const { data, error } = await supabaseClient.rpc('create_contribution_reply', {
            p_campaign_id: currentCampaignId,
            p_contribution_id: pledgeId,
            p_author_name: author,
            p_content: content,
            p_session_token: token
          });

          if (error || !data || !data.ok) {
            throw new Error((data && data.message) || (error && error.message) || '답글 등록에 실패했습니다.');
          }

          await fetchCampaignFromSupabase(currentCampaignId, true);
        } else {
          // Local preview fallback
          const newReply = {
            id: 'r-' + generateRandomHex(6),
            campaignId: currentCampaignId,
            contributionId: pledgeId,
            authorName: author,
            content: content,
            isHost: isAdminAuthenticated,
            createdAt: new Date().toISOString(),
            createdAtLabel: '방금 전'
          };
          state.replies = state.replies || [];
          state.replies.push(newReply);
          saveCurrentStateToLocalMultiDb();
        }

        openReplyThreadIds.add(pledgeId);
        openReplyFormIds.delete(pledgeId);
        renderGuestbookSection();
        showToast('💬 답글이 등록되었습니다!');
      } catch (err) {
        showToast(`답글 등록 오류: ${err.message}`);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = '답글 등록';
        }
      }
    });

    // Delegated Live Char Counter for Reply Textarea
    document.getElementById('blessingGrid').addEventListener('input', (e) => {
      if (e.target.classList.contains('reply-content-input')) {
        const form = e.target.closest('.reply-submit-form');
        const hint = form ? form.querySelector('.reply-char-hint') : null;
        if (hint) {
          const len = e.target.value.length;
          hint.textContent = `${len} / 300자`;
          hint.style.color = len > 300 ? 'var(--accent-danger)' : 'var(--text-muted)';
        }
      }
    });

    // Participant Profile Photo Upload & Remove in Pledge Modal
    document.getElementById('pledgeAvatarFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const result = await compressAvatarFile(file, 256, 0.84);
        pledgeAvatarDataUrl = result.dataUrl;
        pledgeAvatarBlob = result.blob;
        pledgeAvatarMime = result.mime;
        updatePledgeAvatarPreviewUI(pledgeAvatarDataUrl);
        showToast('프로필 사진이 원형 미리보기에 적용되었습니다.');
      } catch (err) {
        e.target.value = '';
        showToast(err.message || '프로필 사진 처리 중 오류가 발생했습니다.');
      }
    });

    document.getElementById('removePledgeAvatarBtn').addEventListener('click', () => {
      resetPledgeAvatarState();
      showToast('프로필 사진이 삭제되어 기본 아이콘으로 표시됩니다.');
    });

    // Self-Service Avatar Manage Modal Events
    document.getElementById('manageAvatarFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const result = await compressAvatarFile(file, 256, 0.84);
        manageAvatarDataUrl = result.dataUrl;
        manageAvatarBlob = result.blob;
        manageAvatarMime = result.mime;
        manageAvatarRemoved = false;
        updateManageModalAvatarPreview(manageAvatarDataUrl);
        showToast('새 프로필 사진이 선택되었습니다.');
      } catch (err) {
        e.target.value = '';
        showToast(err.message || '프로필 사진 처리 중 오류가 발생했습니다.');
      }
    });

    document.getElementById('manageDeleteAvatarBtn').addEventListener('click', () => {
      manageAvatarDataUrl = '';
      manageAvatarBlob = null;
      manageAvatarRemoved = true;
      document.getElementById('manageAvatarFileInput').value = '';
      updateManageModalAvatarPreview('');
      showToast('사진 삭제가 선택되었습니다.');
    });

    document.getElementById('closeAvatarManageModalBtn').addEventListener('click', closeAvatarManageModal);
    document.getElementById('cancelAvatarManageBtn').addEventListener('click', closeAvatarManageModal);
    document.getElementById('avatarManageForm').addEventListener('submit', handleAvatarManageSubmit);

    // Pledge Modal Events
    document.getElementById('closePledgeModalBtn').addEventListener('click', closePledgeModal);
    document.getElementById('cancelPledgeBtn').addEventListener('click', closePledgeModal);
    document.getElementById('pledgeGiftSelect').addEventListener('change', updateSelectedGiftPreview);

    document.getElementById('fillRemainingBtn').addEventListener('click', () => {
      updatePledgeAmountUI(currentGiftMaxTarget, false);
    });

    document.querySelectorAll('.chip-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-amount');
        const current = Number(document.getElementById('pledgeAmountInput').value) || 0;
        if (val === 'reset') {
          updatePledgeAmountUI(0, false);
        } else if (val === 'max') {
          updatePledgeAmountUI(currentGiftMaxTarget, false);
        } else {
          updatePledgeAmountUI(current + Number(val), false);
        }
      });
    });

    document.getElementById('pledgeAmountInput').addEventListener('input', (e) => {
      updatePledgeAmountUI(e.target.value, false);
    });

    document.getElementById('pledgeAmountSlider').addEventListener('input', (e) => {
      updatePledgeAmountUI(e.target.value, true);
    });

    document.getElementById('copyAmountBtn').addEventListener('click', () => {
      const amount = Math.round(Number(document.getElementById('pledgeAmountInput').value) || 0);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(amount)).then(() => {
          showToast(`금액(${formatNumberKo(amount)})이 복사되었습니다.`);
        });
      }
    });

    // Remittance Method Selection Radios
    document.querySelectorAll('input[name="selectedRemitMethod"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        currentSelectedRemitMethod = e.target.value;
        updateSelectedRemitMethodPreview();
      });
    });

    document.getElementById('openKakaoLinkBtn')?.addEventListener('click', () => handleOpenRemitUrl('kakao'));
    document.getElementById('openTossLinkBtn')?.addEventListener('click', () => handleOpenRemitUrl('toss'));
    document.getElementById('copyBankAccountBtn')?.addEventListener('click', handleCopyBankAccount);

    document.getElementById('inlineEditRemitBtn').addEventListener('click', () => {
      closePledgeModal();
      openProfileModal();
    });

    document.getElementById('goRegisterTossLinkBtn').addEventListener('click', () => {
      closePledgeModal();
      openProfileModal();
    });

    document.querySelectorAll('.theme-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        selectedCardTheme = swatch.getAttribute('data-theme') || 'warm-cream';
      });
    });

    const msgInput = document.getElementById('pledgeMessageInput');
    const charCount = document.getElementById('msgCharCount');
    msgInput.addEventListener('input', () => {
      charCount.textContent = String(msgInput.value.length);
    });

    document.getElementById('pledgeForm').addEventListener('submit', handlePledgeSubmit);

    document.getElementById('receiptDoneBtn').addEventListener('click', () => {
      closePledgeModal();
      document.getElementById('guestbookSection').scrollIntoView({ behavior: 'smooth' });
    });

    const receiptReplayBtn = document.getElementById('receiptReplayCelebrationBtn');
    if (receiptReplayBtn) {
      receiptReplayBtn.addEventListener('click', () => {
        playBunnyCelebration(lastPledgedGift);
      });
    }

    // Gift Photo File Upload, URL Input, Fit Radio & Delete Events
    document.getElementById('giftPhotoFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        showToast('⚠️ 사진 크기는 최대 5MB까지 가능합니다.');
        e.target.value = '';
        return;
      }
      giftPhotoRawSource = file;
      openPhotoCropModal({
        source: file,
        initialAspect: 1,
        originalMime: file.type || 'image/jpeg',
        onApply: ({ blob, dataUrl, mime }) => {
          editorPhotoBlob = blob;
          editorPhotoDataUrl = dataUrl;
          editorPhotoMime = mime || 'image/jpeg';
          document.getElementById('giftImageUrlInput').value = '';
          updateEditorPhotoPreview(editorPhotoDataUrl, getSelectedImageFit());
          showToast('사진이 1:1 미리보기에 적용되었습니다.');
        },
        onCancel: () => {
          if (!editorPhotoBlob && !editorPhotoDataUrl) {
            e.target.value = '';
          }
        }
      });
    });

    const recropGiftBtn = document.getElementById('recropGiftPhotoBtn');
    if (recropGiftBtn) {
      recropGiftBtn.addEventListener('click', () => {
        const manualUrl = document.getElementById('giftImageUrlInput').value.trim();
        const src = giftPhotoRawSource || editorPhotoDataUrl || manualUrl;
        if (!src) return;
        openPhotoCropModal({
          source: src,
          initialAspect: 1,
          onApply: ({ blob, dataUrl, mime }) => {
            editorPhotoBlob = blob;
            editorPhotoDataUrl = dataUrl;
            editorPhotoMime = mime || 'image/jpeg';
            document.getElementById('giftImageUrlInput').value = '';
            updateEditorPhotoPreview(editorPhotoDataUrl, getSelectedImageFit());
          }
        });
      });
    }

    document.getElementById('giftImageUrlInput').addEventListener('input', (e) => {
      const urlVal = e.target.value.trim();
      if (urlVal) {
        editorPhotoDataUrl = '';
        editorPhotoBlob = null;
        updateEditorPhotoPreview(urlVal, getSelectedImageFit());
      } else {
        updateEditorPhotoPreview(editorPhotoDataUrl, getSelectedImageFit());
      }
    });

    document.querySelectorAll('input[name="giftImageFit"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const currentSrc = document.getElementById('giftImageUrlInput').value.trim() || editorPhotoDataUrl;
        updateEditorPhotoPreview(currentSrc, getSelectedImageFit());
      });
    });

    document.getElementById('removeGiftPhotoBtn').addEventListener('click', () => {
      editorPhotoDataUrl = '';
      editorPhotoBlob = null;
      giftPhotoRawSource = null;
      document.getElementById('giftPhotoFileInput').value = '';
      document.getElementById('giftImageUrlInput').value = '';
      updateEditorPhotoPreview('', getSelectedImageFit());
      showToast('선물 사진이 삭제되었습니다. (기본 일러스트가 표시됩니다)');
    });

    document.getElementById('closeGiftModalBtn').addEventListener('click', closeGiftModal);
    document.getElementById('cancelGiftModalBtn').addEventListener('click', closeGiftModal);
    document.getElementById('giftForm').addEventListener('submit', handleGiftFormSubmit);

    document.getElementById('closeProfileModalBtn').addEventListener('click', closeProfileModal);
    document.getElementById('cancelProfileModalBtn').addEventListener('click', closeProfileModal);
    document.getElementById('profileForm').addEventListener('submit', handleProfileFormSubmit);

    // Profile Event Type selector change
    const profileEventTypeSel = document.getElementById('profileEventTypeSelect');
    const profileEventCustomBox = document.getElementById('profileEventCustomBox');
    const hostEmojiSelect = document.getElementById('hostEmojiSelect');
    const hostHeadlineInput = document.getElementById('hostHeadlineInput');
    const hostNameEditInput = document.getElementById('hostNameEditInput');

    if (profileEventTypeSel) {
      profileEventTypeSel.addEventListener('change', () => {
        const val = profileEventTypeSel.value;
        if (profileEventCustomBox) {
          profileEventCustomBox.hidden = val !== 'custom';
        }
        const cfg = EVENT_TYPE_CONFIG[val] || EVENT_TYPE_CONFIG.general;
        if (hostEmojiSelect) {
          hostEmojiSelect.value = cfg.emoji;
        }
        const currentName = (hostNameEditInput && hostNameEditInput.value.trim()) || '주인공';
        if (hostHeadlineInput && !hostHeadlineInput.value.trim()) {
          hostHeadlineInput.placeholder = `미입력 시 '${cfg.defaultHeadline(currentName)}'`;
        }
      });
    }

    // Owner Settings Intro Photo Events
    const profilePhotoInput = document.getElementById('profileIntroPhotoInput');
    const profilePhotoImg = document.getElementById('profileIntroPhotoImg');
    const profileFitSelect = document.getElementById('profileIntroPhotoFitSelect');
    const profileDeleteBtn = document.getElementById('profileIntroPhotoDeleteBtn');
    const profileRecropBtn = document.getElementById('profileIntroPhotoRecropBtn');
    const profileStatusText = document.getElementById('profileIntroPhotoStatusText');

    if (profilePhotoInput) {
      profilePhotoInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
          showToast('⚠️ 사진 크기는 최대 5MB까지 가능합니다.');
          profilePhotoInput.value = '';
          return;
        }
        profileIntroPhotoRawSource = file;
        openPhotoCropModal({
          source: file,
          initialAspect: 1,
          originalMime: file.type || 'image/jpeg',
          onApply: ({ blob, dataUrl }) => {
            profileSelectedIntroBlob = blob;
            profileSelectedIntroFile = new File([blob], file.name || 'intro.jpg', { type: blob.type });
            profileIntroPhotoCropDataUrl = dataUrl;
            profileIntroPhotoMarkedForDelete = false;

            if (profilePhotoImg) {
              profilePhotoImg.src = dataUrl;
              profilePhotoImg.className = `intro-preview-thumbnail fit-${(profileFitSelect && profileFitSelect.value === 'contain') ? 'contain' : 'cover'}`;
              profilePhotoImg.hidden = false;
            }
            const photoPlaceholder = document.getElementById('profileIntroPhotoPlaceholder');
            if (photoPlaceholder) photoPlaceholder.hidden = true;
            if (profileDeleteBtn) profileDeleteBtn.hidden = false;
            if (profileRecropBtn) profileRecropBtn.hidden = false;
            if (profileStatusText) profileStatusText.textContent = '새 사진 편집 완료 (저장 시 적용)';
          },
          onCancel: () => {
            if (!profileSelectedIntroFile && !state.campaign.introImageUrl) {
              profilePhotoInput.value = '';
            }
          }
        });
      });
    }

    if (profileRecropBtn) {
      profileRecropBtn.addEventListener('click', () => {
        const currentSrc = profileIntroPhotoRawSource || profileIntroPhotoCropDataUrl || (profilePhotoImg && profilePhotoImg.src) || (state.campaign && getIntroPhotoPublicUrl(state.campaign.introImageUrl));
        if (!currentSrc) return;
        openPhotoCropModal({
          source: currentSrc,
          initialAspect: 1,
          onApply: ({ blob, dataUrl }) => {
            profileSelectedIntroBlob = blob;
            profileSelectedIntroFile = new File([blob], 'intro_crop.jpg', { type: blob.type });
            profileIntroPhotoCropDataUrl = dataUrl;
            profileIntroPhotoMarkedForDelete = false;

            if (profilePhotoImg) {
              profilePhotoImg.src = dataUrl;
              profilePhotoImg.hidden = false;
            }
            const photoPlaceholder = document.getElementById('profileIntroPhotoPlaceholder');
            if (photoPlaceholder) photoPlaceholder.hidden = true;
            if (profileDeleteBtn) profileDeleteBtn.hidden = false;
            profileRecropBtn.hidden = false;
            if (profileStatusText) profileStatusText.textContent = '사진 편집 완료 (저장 시 적용)';
          }
        });
      });
    }

    if (profileFitSelect && profilePhotoImg) {
      profileFitSelect.addEventListener('change', () => {
        profilePhotoImg.className = `intro-preview-thumbnail fit-${profileFitSelect.value === 'contain' ? 'contain' : 'cover'}`;
      });
    }

    if (profileDeleteBtn) {
      profileDeleteBtn.addEventListener('click', () => {
        profileSelectedIntroFile = null;
        profileSelectedIntroBlob = null;
        profileIntroPhotoRawSource = null;
        profileIntroPhotoCropDataUrl = '';
        profileIntroPhotoMarkedForDelete = true;
        if (profilePhotoInput) profilePhotoInput.value = '';
        if (profilePhotoImg) {
          profilePhotoImg.src = '';
          profilePhotoImg.hidden = true;
        }
        const photoPlaceholder = document.getElementById('profileIntroPhotoPlaceholder');
        if (photoPlaceholder) photoPlaceholder.hidden = false;
        profileDeleteBtn.hidden = true;
        if (profileRecropBtn) profileRecropBtn.hidden = true;
        if (profileStatusText) profileStatusText.textContent = '저장 시 사진이 삭제됩니다';
      });
    }

    // Photo Crop Modal Interactive Controls & Button Listeners
    document.querySelectorAll('.crop-ratio-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!activeCropper) return;
        document.querySelectorAll('.crop-ratio-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const r = btn.getAttribute('data-ratio');
        if (r === 'free') {
          activeCropper.setAspectRatio(NaN);
        } else {
          activeCropper.setAspectRatio(Number(r));
        }
      });
    });

    const cropSlider = document.getElementById('cropZoomSlider');
    if (cropSlider) {
      cropSlider.addEventListener('input', (e) => {
        if (!activeCropper) return;
        activeCropper.zoomTo(parseFloat(e.target.value));
      });
    }
    document.getElementById('cropZoomInBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropper.zoom(0.15);
    });
    document.getElementById('cropZoomOutBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropper.zoom(-0.15);
    });

    document.getElementById('cropRotateLeftBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropper.rotate(-90);
    });
    document.getElementById('cropRotateRightBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropper.rotate(90);
    });
    document.getElementById('cropFlipHBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropScaleX = -activeCropScaleX;
      activeCropper.scaleX(activeCropScaleX);
    });

    document.getElementById('cropResetBtn')?.addEventListener('click', () => {
      if (!activeCropper) return;
      activeCropper.reset();
      activeCropScaleX = 1;
      if (cropSlider) cropSlider.value = 1;
    });

    document.getElementById('cropCancelBtn')?.addEventListener('click', () => closePhotoCropModal(true));
    document.getElementById('closePhotoCropModalBtn')?.addEventListener('click', () => closePhotoCropModal(true));
    document.getElementById('photoCropModalBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'photoCropModalBackdrop') closePhotoCropModal(true);
    });

    document.getElementById('cropApplyBtn')?.addEventListener('click', () => {
      if (!activeCropper || !activeCropContext) return;
      const ctx = activeCropContext;
      const isPng = ctx.originalMime === 'image/png';
      const outputMime = isPng ? 'image/png' : 'image/jpeg';

      const canvas = activeCropper.getCroppedCanvas({
        maxWidth: 1200,
        maxHeight: 1200,
        fillColor: isPng ? 'transparent' : '#FFFFFF',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
      });

      if (!canvas) {
        showToast('⚠️ 사진을 자르는 중 오류가 발생했습니다.');
        return;
      }

      canvas.toBlob((blob) => {
        if (!blob) {
          showToast('⚠️ 이미지 변환에 실패했습니다.');
          return;
        }
        if (blob.size > MAX_UPLOAD_FILE_BYTES) {
          showToast('⚠️ 편집된 사진 크기가 5MB를 초과합니다. 다른 크기로 시도해 주세요.');
          return;
        }
        const dataUrl = canvas.toDataURL(outputMime, 0.88);
        if (typeof ctx.onApply === 'function') {
          try {
            ctx.onApply({ blob, dataUrl, mime: outputMime });
          } catch (e) {
            console.error('[Cropper] onApply error:', e);
          }
        }
        closePhotoCropModal(false);
        showToast('✂️ 사진 편집이 완료되었습니다!');
      }, outputMime, 0.88);
    });

    const retryDeleteBtn = document.getElementById('profileRetryDeletePendingBtn');
    if (retryDeleteBtn) {
      retryDeleteBtn.addEventListener('click', async () => {
        const pendingPath = state.campaign && state.campaign.pendingDeleteImageUrl;
        if (!pendingPath) {
          showToast('삭제 대기 중인 잔여 파일이 없습니다.');
          return;
        }
        if (!requireAdminPermission('잔여 사진 파일 삭제')) return;

        retryDeleteBtn.disabled = true;
        retryDeleteBtn.textContent = '⏳ 파일 삭제 중...';

        try {
          if (isCloudConnected && supabaseClient && isCurrentCampaignCloud) {
            const token = getStoredOwnerSessionToken(currentCampaignId);
            const cfg = resolveSupabaseConnectionConfig();
            const bucketName = (cfg.bucket || DEFAULT_BUCKET_NAME).trim();
            const { error: removeErr } = await supabaseClient.storage.from(bucketName).remove([pendingPath]);
            if (removeErr) {
              throw new Error(`Storage 삭제 API 오류: ${removeErr.message}`);
            }

            const { data: confRes, error: confErr } = await supabaseClient.rpc('owner_confirm_intro_deleted', {
              p_campaign_id: currentCampaignId,
              p_session_token: token,
              p_deleted_path: pendingPath
            });

            if (confErr || !confRes || !confRes.ok) {
              const detailedErr = formatSupabaseRpcError(confErr, confRes, '삭제 완료 확인 실패');
              throw new Error(detailedErr);
            }

            await fetchCampaignFromSupabase(currentCampaignId, true);
          } else {
            state.campaign.pendingDeleteImageUrl = '';
            saveCurrentStateToLocalMultiDb();
          }

          const pendingBox = document.getElementById('profilePendingDeleteBox');
          if (pendingBox) pendingBox.hidden = true;
          showToast('✅ Storage 잔여 사진 파일이 성공적으로 삭제되었습니다!');
        } catch (err) {
          showToast(`❌ 잔여 파일 삭제 실패: ${err.message}`, 5000);
        } finally {
          retryDeleteBtn.disabled = false;
          retryDeleteBtn.textContent = '🗑️ 잔여 파일 지금 삭제';
        }
      });
    }

    // Modal 5: Owner Password Auth & Dev Supabase Connect Events
    document.getElementById('closeAdminAuthModalBtn').addEventListener('click', closeAdminAuthModal);
    document.getElementById('cancelAdminAuthModalBtn').addEventListener('click', closeAdminAuthModal);
    document.getElementById('adminLoginForm').addEventListener('submit', handleAdminLoginSubmit);
    document.getElementById('adminLogoutBtn').addEventListener('click', handleAdminLogout);
    document.getElementById('supabaseConnectForm').addEventListener('submit', handleSupabaseConnectSubmit);
    document.getElementById('adminOpenCampaignConfigBtn').addEventListener('click', () => {
      closeAdminAuthModal();
      openProfileModal();
    });

    document.getElementById('copyAppJsConfigSnippetBtn').addEventListener('click', () => {
      const rawUrl = document.getElementById('quickSupabaseUrlInput').value.trim();
      const cleanUrl = normalizeSupabaseProjectUrl(rawUrl) || rawUrl;
      const rawKey = document.getElementById('quickSupabaseAnonKeyInput').value.trim();
      const snippet = `const SUPABASE_PROJECT_URL = '${cleanUrl}';\nconst SUPABASE_PUBLISHABLE_KEY = '${rawKey}';`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(snippet).then(() => {
          showToast('app.js 상단 배포용 설정 코드가 복사되었습니다!');
        });
      }
    });

    // Birthday Intro Skip & Replay Buttons
    const skipIntroBtn = document.getElementById('skipIntroBtn');
    if (skipIntroBtn) {
      skipIntroBtn.addEventListener('click', () => finishBirthdayIntro());
    }

    const replayIntroBtn = document.getElementById('replayIntroBtn');
    if (replayIntroBtn) {
      replayIntroBtn.addEventListener('click', async () => {
        closeBunnyCelebration();
        document.getElementById('dataDropdownMenu').hidden = true;
        await prepareAndBindIntro();
        startBirthdayIntroAnimation(true);
      });
    }

    const mobileReplayIntroBtn = document.getElementById('mobileReplayIntroBtn');
    if (mobileReplayIntroBtn) {
      mobileReplayIntroBtn.addEventListener('click', async () => {
        closeBunnyCelebration();
        closeMobileDrawer();
        await prepareAndBindIntro();
        startBirthdayIntroAnimation(true);
      });
    }

    // Bunny 100% Celebration Sound Toggle & Close Events
    const bunnySoundToggleBtn = document.getElementById('bunnySoundToggleBtn');
    if (bunnySoundToggleBtn) {
      updateSoundToggleButtonUI();
      bunnySoundToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentlyEnabled = isCelebrationSoundEnabled();
        const nextState = !currentlyEnabled;
        setCelebrationSoundEnabled(nextState);
        if (nextState) {
          playCelebrationFanfare();
          showToast('🔊 축하 효과음이 켜졌습니다');
        } else {
          stopCelebrationFanfare(false);
          showToast('🔇 축하 효과음이 꺼졌습니다');
        }
      });
    }

    const bunnyCloseBtn = document.getElementById('bunnyCloseBtn');
    if (bunnyCloseBtn) {
      bunnyCloseBtn.addEventListener('click', closeBunnyCelebration);
    }
    const bunnyBackdrop = document.getElementById('bunnyCelebrationBackdrop');
    if (bunnyBackdrop) {
      bunnyBackdrop.addEventListener('click', closeBunnyCelebration);
    }

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          if (backdrop.id === 'userGuideModalBackdrop') {
            closeUserGuideModal();
          } else if (backdrop.id === 'findFundingModalBackdrop') {
            closeFindFundingModal();
          } else {
            backdrop.hidden = true;
            backdrop.setAttribute('aria-hidden', 'true');
          }
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePhotoCropModal(true);
        if (!introFinished) {
          finishBirthdayIntro();
        }
        closeBunnyCelebration();
        closeUserGuideModal();
        closeFindFundingModal();
        closePledgeModal();
        closeAvatarManageModal();
        closeGiftModal();
        closeProfileModal();
        closeAdminAuthModal();
        closeMobileDrawer();
      }
    });

    document.getElementById('printSummaryBtn').addEventListener('click', () => {
      window.print();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    try {
      localStorage.removeItem('bday_multi_recent_fundings_v1');
    } catch (e) {}
    try {
      getFanfareAudioElement();
    } catch (e) {}
    migrateLegacyDeviceCampaigns();
    bindEvents();
    initSupabaseAndRoute();
  });
})();
