import { useState, useEffect, useRef, Fragment } from 'react';
import { Client } from '@stomp/stompjs';
import type { 
  Deck, 
  PlayerView, 
  RoomState, 
  GameResult, 
  ErrorResponse,
  PlayerStats
} from './types';
import './App.css';

// 카드 발자국 매핑 (스프린트 값 계산용: 짝수 번호는 2발자국, 홀수 번호는 1발자국)
function getSprintValue(cardNumber: number): number {
  return cardNumber % 2 === 0 ? 2 : 1;
}

// WebSocket 세션 해제 시 발생할 수 있는 CLOSING/CLOSED 상태 오류를 방어하기 위한 안전 구독 해제 함수
const safeUnsubscribe = (sub: any) => {
  if (sub) {
    try {
      sub.unsubscribe();
    } catch (e) {
      console.warn("Unsubscribe skipped (connection closed or closing):", e);
    }
  }
};


// Web Audio API를 활용한 효과음 합성 유틸리티 (무설치, 즉시 구동 가능!)
const playSynthSound = (type: 'click' | 'success' | 'error' | 'turn' | 'draw') => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    
    if (type === 'draw') {
      // 1. 노이즈 버퍼 생성 (카드가 쓸리며 사르륵 뽑히는 마찰음을 위한 화이트 노이즈)
      const bufferSize = ctx.sampleRate * 0.22; // 0.22초 길이
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      
      // 2. 대역 통과 필터 (Bandpass Filter)로 사각거리는 높은 중고역대 주파수 강조
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2200, now); // 종이/카드 마찰음 주파수 대역
      filter.Q.setValueAtTime(1.8, now);
      filter.frequency.exponentialRampToValueAtTime(800, now + 0.22); // 주파수 하강 스윕 (사-라-락)
      
      // 3. 마찰음 볼륨 엔벨로프
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0, now);
      noiseGain.gain.linearRampToValueAtTime(0.08, now + 0.04); // 아주 빠른 페이드인
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22); // 서서히 사라짐
      
      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      
      // 4. 서브 우퍼 오실레이터 (카드를 쥐어 뽑는 물리적인 무게감 베이스 추가)
      const subOsc = ctx.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(160, now);
      subOsc.frequency.exponentialRampToValueAtTime(100, now + 0.22);
      
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.03, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      
      subOsc.connect(subGain);
      subGain.connect(ctx.destination);
      
      noise.start(now);
      noise.stop(now + 0.22);
      subOsc.start(now);
      subOsc.stop(now + 0.22);
      return;
    }
    
    // 일반 타입용 오실레이터 세팅
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'click') {
      // 가볍고 명쾌한 인터랙션 클릭음
      osc.type = 'sine';
      osc.frequency.setValueAtTime(900, now);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (type === 'success') {
      // 긍정적인 메이저 3도 화음 아르페지오 (성공/배치)
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.setValueAtTime(659.25, now + 0.06); // E5
      osc.frequency.setValueAtTime(783.99, now + 0.12); // G5
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'error') {
      // 둔탁한 저주파 버저음 (오류 알림)
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.setValueAtTime(110, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'turn') {
      // 차임벨 벨소리 (나의 턴 알림)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.12); // D6
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch {
    // 브라우저의 오디오 자동재생 제약 등의 오류 무시
  }
};

// 서버 에러 코드에 대응하는 한글 번역 사전 유틸리티
const translateErrorCode = (code: string, fallbackMessage: string): string => {
  const lowerMsg = (fallbackMessage || '').toLowerCase();
  
  // 1. 메시지 내용 기반 동적 한글 매핑 (코드 분기가 누락되었거나 서버에서 원시 메시지만 보낸 경우 예외 대응)
  if (lowerMsg.includes('already has a guest') || lowerMsg.includes('room is full')) {
    return '이미 다른 플레이어가 참여해 가득 찬 방입니다.';
  }
  if (lowerMsg.includes('room not found') || lowerMsg.includes('cannot find room')) {
    return '방을 찾을 수 없습니다. 방 ID를 재확인해주세요.';
  }
  if (lowerMsg.includes('not your turn')) {
    return '당신의 차례가 아닙니다.';
  }
  if (lowerMsg.includes('must draw first') || lowerMsg.includes('draw card first')) {
    return '차례를 넘기거나 카드를 내기 전에 먼저 카드를 뽑으셔야 합니다.';
  }
  if (lowerMsg.includes('not ascending')) {
    return '새 은신처는 반드시 직전 은신처 번호보다 커야 합니다.';
  }
  if (lowerMsg.includes('gap exceeded') || lowerMsg.includes('insufficient sprint') || lowerMsg.includes('sprint power')) {
    return '이동 거리(최대 3칸)를 초과했습니다. 도약 발자국 카드가 더 필요합니다.';
  }

  // 2. 고유 에러 코드 기반 분기 처리
  switch (code) {
    case 'ROOM_NOT_FOUND': return '방을 찾을 수 없습니다. 방 ID를 재확인해주세요.';
    case 'ROOM_FULL': return '방이 꽉 찼습니다.';
    case 'ROOM_ALREADY_STARTED': return '이미 시작된 게임입니다.';
    case 'NOT_HOST': return '방장만 게임을 시작할 수 있습니다.';
    case 'GUEST_NOT_PRESENT': return '게임에 참여할 참가자가 없습니다.';
    case 'NOT_READY': return '참가자가 아직 준비(READY) 상태가 아닙니다.';
    case 'INVALID_ROLE': return '역할 선택이 올바르지 않습니다. 도망자 또는 수사관을 선택해 주세요.';
    
    // 게임 수 규칙 에러 (RULE_VIOLATION)
    case 'GAME_ALREADY_ENDED': return '이미 종료된 게임입니다.';
    case 'NOT_YOUR_TURN': return '당신의 차례가 아닙니다.';
    case 'ILLEGAL_MOVE_FOR_PHASE': return '현재 단계에서 허용되지 않는 행동입니다.';
    case 'MUST_DRAW_FIRST': return '차례를 넘기거나 카드를 내기 전에 먼저 카드를 뽑으셔야 합니다.';
    case 'NO_DRAW_EXPECTED': return '이번 차례에는 더 이상 카드를 뽑을 수 없습니다.';
    case 'DECK_EMPTY': return '선택한 카드 더미가 비어 있습니다.';
    case 'CARD_NOT_IN_HAND': return '손패에 보유하고 있지 않은 카드입니다.';
    case 'NOT_ASCENDING': return '새 은신처는 반드시 직전 은신처 번호보다 커야 합니다.';
    case 'GAP_EXCEEDED': return '이동 거리(최대 3칸)를 초과했습니다. 도약 발자국 카드가 더 필요합니다.';
    case 'TOO_MANY_HIDEOUTS': return '더 이상 은신처를 설치할 수 없습니다.';
    case 'DUPLICATE_SPRINT_CARD': return '중복된 카드를 도약으로 등록할 수 없습니다.';
    case 'ILLEGAL_GUESS': return '유효하지 않은 추측 숫자입니다.';
    
    // 접근 및 본문 에러
    case 'GAME_NOT_STARTED': return '게임이 아직 시작되지 않았습니다.';
    case 'NOT_A_PARTICIPANT': return '본 게임의 참가자가 아닙니다.';
    case 'MALFORMED_MOVE': return '잘못된 형식의 요청입니다.';
    
    default: return fallbackMessage || '유효하지 않은 행동입니다. 규칙을 다시 확인해주세요.';
  }
};

// UTF-8 캐릭터셋(예: 한글)이 깨지지 않도록 디코딩을 처리하는 JWT 디코더 유틸리티
const decodeJwtPayload = (token: string) => {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const payload = JSON.parse(jsonPayload);
    // Kakao 및 OIDC 표준 필드명 매핑 정규화
    payload.nickname = payload.nickname || payload.name || (payload.properties && payload.properties.nickname) || payload.sub;
    return payload;
  } catch (e) {
    console.error("decodeJwtPayload error", e);
    return null;
  }
};

// 덱 카드 장수에 따라 물리적 두께감을 그림자로 렌더링하는 스타일 헬퍼
const getDeckStyle = (count: number) => {
  if (count === 0) {
    return { opacity: 0.25, boxShadow: 'none', border: '1px dashed rgba(255,255,255,0.12)' };
  }
  const shadows = [];
  // 3장당 1px씩 그림자 층을 두껍게 쌓아 두께감 표현
  const layers = Math.min(5, Math.ceil(count / 2.5));
  for (let i = 1; i <= layers; i++) {
    shadows.push(`${i * 1.5}px ${i * 1.5}px 0px rgba(0, 0, 0, 0.4)`);
    shadows.push(`${i * 1.5}px ${i * 1.5}px 0px var(--border-neon)`);
  }
  return {
    boxShadow: shadows.join(', '),
    transform: `translate(-${layers}px, -${layers}px)`
  };
};

interface SetupDealLocal {
  fixed: number[];
  deck1Queue: number[];
  deck2Queue: number[];
  deck1Drawn: number[];
  deck2Drawn: number[];
}

// 서버 호스트를 기반으로 http 및 ws 프로토콜과 깔끔한 호스트 주소를 얻는 헬퍼
function getProtocols(host: string) {
  let cleanHost = host;
  let httpProto = 'http://';
  let wsProto = 'ws://';

  if (host.startsWith('http://') || host.startsWith('https://')) {
    try {
      const url = new URL(host);
      cleanHost = url.host;
      httpProto = url.protocol + '//';
      wsProto = url.protocol === 'https:' ? 'wss://' : 'ws://';
    } catch (e) {
      console.error(e);
    }
  } else {
    // 호스트에 프로토콜이 명시되지 않은 경우, localhost/127.0.0.1이 아니거나 현재 페이지가 https이면 https/wss 적용
    const useSecure = window.location.protocol === 'https:' || (!host.includes('localhost') && !host.includes('127.0.0.1'));
    httpProto = useSecure ? 'https://' : 'http://';
    wsProto = useSecure ? 'wss://' : 'ws://';
  }
  return { cleanHost, httpProto, wsProto };
}

function App() {
  // 연결 및 식별 정보 상태
  const [playerId, setPlayerId] = useState<string>(() => {
    return localStorage.getItem('fugitive_playerId') || '';
  });
  const [nickname, setNickname] = useState<string>(() => {
    return localStorage.getItem('fugitive_nickname') || '';
  });
  const [serverHost] = useState<string>(() => {
    return import.meta.env.VITE_SERVER_HOST || localStorage.getItem('fugitive_serverHost') || 'localhost:8080';
  });
  const { cleanHost, httpProto, wsProto } = getProtocols(serverHost);

  const [connectionStatus, setConnectionStatus] = useState<'CONNECTED' | 'DISCONNECTED' | 'CONNECTING'>('DISCONNECTED');
  const [screen, setScreen] = useState<'HOME' | 'LOBBY' | 'WAITING' | 'GAME'>('HOME');
  const [theme] = useState<'dark' | 'light'>('light');

  // 자동 소켓 연결 동기화를 위한 트리거 플래그
  const [shouldConnect, setShouldConnect] = useState<boolean>(false);

  // 활성화된 방/게임 상태
  const [roomId, setRoomId] = useState<string>('');
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [hostRole, setHostRole] = useState<'FUGITIVE' | 'MARSHAL'>('FUGITIVE');
  const [playerView, setPlayerView] = useState<PlayerView | null>(null);
  const [setupDealLocal, setSetupDealLocal] = useState<SetupDealLocal | null>(null);
  const [history, setHistory] = useState<GameResult[]>([]);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [toasts, setToasts] = useState<{ id: string; kind: 'default' | 'success' | 'error' | 'info' | 'warning'; title?: string; message: string }[]>([]);
  const [copied, setCopied] = useState<boolean>(false);
  const [showRoleIntro, setShowRoleIntro] = useState<boolean>(false);
  const [introCountdown, setIntroCountdown] = useState<number>(5);

  // 카드 드로우 연출 상태
  const [drawnCardEffect, setDrawnCardEffect] = useState<{
    number: number;
    sprintValue: number;
    role: 'FUGITIVE' | 'MARSHAL';
    visible: boolean;
  } | null>(null);

  const drawEffectTimerRef = useRef<any>(null);

  const triggerDrawEffect = (cardNumber: number, role: 'FUGITIVE' | 'MARSHAL') => {
    if (drawEffectTimerRef.current) {
      clearTimeout(drawEffectTimerRef.current);
    }
    setDrawnCardEffect({
      number: cardNumber,
      sprintValue: getSprintValue(cardNumber),
      role: role,
      visible: true
    });
    drawEffectTimerRef.current = setTimeout(() => {
      setDrawnCardEffect(prev => prev ? { ...prev, visible: false } : null);
    }, 2200);
  };

  // STOMP 클라이언트 참조
  const stompClientRef = useRef<Client | null>(null);

  // 현재 활성화된 방 구독(Subscription) 참조 (방 퇴장 시 정상 수신 해제용)
  const roomSubscriptionRef = useRef<any>(null);

  // 수사관의 추측 정보 공유용 브로드캐스트 구독 참조
  const gameSubscriptionRef = useRef<any>(null);
  const lastReceivedGuessRef = useRef<any>(null);

  const roomIdRef = useRef<string>('');
  const isRematchingRef = useRef<boolean>(false);

  // 실시간 게임 로그 자동 스크롤을 위한 참조
  const logPanelRef = useRef<HTMLDivElement>(null);

  const playerViewRef = useRef<PlayerView | null>(null);
  const screenRef = useRef<'HOME' | 'LOBBY' | 'WAITING' | 'GAME'>('HOME');
  useEffect(() => {
    playerViewRef.current = playerView;
  }, [playerView]);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  // 도망자(Fugitive) 액션 로컬 상태
  const [selectedHideoutCard, setSelectedHideoutCard] = useState<number | null>(null);
  const [selectedSprintCards, setSelectedSprintCards] = useState<number[]>([]);
  const [hasDrawnThisTurn, setHasDrawnThisTurn] = useState<boolean>(false);
  const [gameSeconds, setGameSeconds] = useState<number>(() => {
    return parseInt(localStorage.getItem('fugitive_gameSeconds') || '0', 10);
  });

  const formatGameTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  };

  // 플레이어 ID를 실시간 캐시 또는 로컬 세션을 활용해 사람이 읽을 수 있는 닉네임으로 디코딩하는 리졸버
  const getPlayerDisplayName = (pid: string, record?: GameResult) => {
    if (!pid) return "";
    
    // 1. 만약 현재 로그인한 플레이어 본인이면, 즉시 상태에 보관된 닉네임 반환
    if (pid === playerId) {
      return nickname || pid;
    }
    
    // 2. 만약 해당 전적 레코드 내에 이미 닉네임 필드가 서버로부터 제공되었다면 그것을 사용 (다양한 백엔드 네이밍 대응)
    if (record) {
      const rec = record as any;
      if (pid === rec.fugitivePlayerId) {
        const name = rec.fugitiveNickname || rec.fugitiveName || rec.fugitivePlayerNickname || rec.fugitivePlayerName;
        if (name) return name;
      }
      if (pid === rec.marshalPlayerId) {
        const name = rec.marshalNickname || rec.marshalName || rec.marshalPlayerNickname || rec.marshalPlayerName;
        if (name) return name;
      }
      if (pid === rec.winnerPlayerId) {
        const name = rec.winnerNickname || rec.winnerName || rec.winnerPlayerNickname || rec.winnerPlayerName;
        if (name) return name;
      }
    }

    // 3. 로컬 닉네임 캐시 저장소(Local Storage Cache)에서 매핑 검색
    try {
      const cache = JSON.parse(localStorage.getItem("fugitive_nickname_cache") || "{}");
      if (cache[pid]) {
        return cache[pid];
      }
    } catch (e) {
      console.error("Failed to read nickname cache", e);
    }
    
    return pid;
  };

  const getMyRoleLabel = (record: GameResult) => {
    if (record.fugitivePlayerId === playerId) {
      return '도망자';
    }
    if (record.marshalPlayerId === playerId) {
      return '수사관';
    }
    return '-';
  };

  const getOpponentDisplayName = (record: GameResult) => {
    if (record.fugitivePlayerId === playerId) {
      return getPlayerDisplayName(record.marshalPlayerId, record);
    }
    if (record.marshalPlayerId === playerId) {
      return getPlayerDisplayName(record.fugitivePlayerId, record);
    }
    return '-';
  };

  // 로그아웃 처리 유틸리티
  const handleLogoutCleanly = async () => {
    const refreshToken = localStorage.getItem("refreshToken");
    if (refreshToken) {
      try {
        await fetch(`${httpProto}${cleanHost}/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken })
        });
      } catch (e) {
        console.error("Logout request failed", e);
      }
    }
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("fugitive_playerId");
    localStorage.removeItem("fugitive_nickname");
    localStorage.removeItem("fugitive_roomId");
    localStorage.removeItem("fugitive_gameSeconds");
    localStorage.removeItem("fugitive_gameStartTime");
    localStorage.removeItem("fugitive_deckSumAtTurnStart");
    localStorage.removeItem("fugitive_marshalDrawCount");
    localStorage.removeItem("fugitive_notepadNotes");
    setPlayerId("");
    setNickname("");
    if (stompClientRef.current) {
      stompClientRef.current.deactivate();
    }
    setConnectionStatus('DISCONNECTED');
    setScreen('HOME');
    addToast('로그아웃되었습니다.');
  };

  // Bearer 토큰 인증 및 만료 시 자동 토큰 갱신(Refresh) 기능이 내장된 fetch 래퍼
  const authenticatedFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    let token = localStorage.getItem("accessToken");
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    
    let res = await fetch(url, { ...options, headers });
    
    if (res.status === 401) {
      const refreshToken = localStorage.getItem("refreshToken");
      if (refreshToken) {
        try {
          const refreshRes = await fetch(`${httpProto}${cleanHost}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken })
          });
          
          if (refreshRes.ok) {
            const data = await refreshRes.json();
            const newAccess = data.accessToken;
            const newRefresh = data.refreshToken;
            
            localStorage.setItem("accessToken", newAccess);
            localStorage.setItem("refreshToken", newRefresh);
            
            const payload = decodeJwtPayload(newAccess);
            if (payload) {
              setPlayerId(payload.sub);
              setNickname(payload.nickname);
              localStorage.setItem("fugitive_playerId", payload.sub);
              localStorage.setItem("fugitive_nickname", payload.nickname);
            }
            
            headers.set("Authorization", `Bearer ${newAccess}`);
            res = await fetch(url, { ...options, headers });
          } else {
            handleLogoutCleanly();
          }
        } catch {
          handleLogoutCleanly();
        }
      } else {
        handleLogoutCleanly();
      }
    }
    return res;
  };

  // OAuth 콜백 라우트 처리 및 자동 로그인 마운트 훅
  useEffect(() => {
    if (window.location.pathname === '/auth/callback') {
      const hash = window.location.hash.slice(1);
      const params = new URLSearchParams(hash);
      const error = params.get("error");
      
      if (error) {
        addToast("🚨 카카오 로그인에 실패했습니다. 다시 시도해 주세요.");
        window.history.replaceState({}, "", "/");
        setScreen('HOME');
        return;
      }
      
      const accessToken = params.get("accessToken");
      const refreshToken = params.get("refreshToken");
      
      if (accessToken && refreshToken) {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        
        const payload = decodeJwtPayload(accessToken);
        if (payload) {
          const pid = payload.sub;
          const nick = payload.nickname;
          
          setPlayerId(pid);
          setNickname(nick);
          localStorage.setItem("fugitive_playerId", pid);
          localStorage.setItem("fugitive_nickname", nick);
          
          addToast("🎉 로그인 성공! 게임 로비에 입장합니다.");
          playSynthSound('success');
          
          window.history.replaceState({}, "", "/");
          setScreen('LOBBY');
          setShouldConnect(true);
        } else {
          addToast("🚨 토큰 해석 도중 오류가 발생했습니다.");
          window.history.replaceState({}, "", "/");
          setScreen('HOME');
        }
      }
    } else {
      const token = localStorage.getItem("accessToken");
      if (token) {
        const payload = decodeJwtPayload(token);
        if (payload) {
          const pid = payload.sub;
          const nick = payload.nickname;
          
          setPlayerId(pid);
          setNickname(nick);
          setScreen('LOBBY');
          setShouldConnect(true);
        } else {
          localStorage.removeItem("accessToken");
          localStorage.removeItem("refreshToken");
        }
      }
    }
  }, []);

  // playerId가 설정되고 연결 신호가 들어왔을 때 소켓 연결을 수행하는 훅
  useEffect(() => {
    if (shouldConnect && playerId) {
      setShouldConnect(false);
      handleConnect();
    }
  }, [shouldConnect, playerId]);

  // 대기방 토픽을 통한 닉네임 교환 및 공유 효과 (방 입장 시 레이스 컨디션 및 타 플레이어 닉네임 전송)
  useEffect(() => {
    if (stompClientRef.current && connectionStatus === 'CONNECTED' && roomState && roomId) {
      const isHost = playerId === roomState.hostId;
      const isGuest = playerId === roomState.guestId;
      
      // 내 역할에 따라 닉네임 필드가 비어있거나 다르면, 내 닉네임을 담아 토픽에 재발행하여 상대 플레이어에게 전송
      if (isHost && roomState.hostNickname !== nickname) {
        stompClientRef.current.publish({
          destination: `/topic/room/${roomId}`,
          body: JSON.stringify({
            ...roomState,
            hostNickname: nickname
          })
        });
      } else if (isGuest && roomState.guestNickname !== nickname) {
        stompClientRef.current.publish({
          destination: `/topic/room/${roomId}`,
          body: JSON.stringify({
            ...roomState,
            guestNickname: nickname
          })
        });
      }
    }
  }, [roomState, connectionStatus, roomId, playerId, nickname]);

  // 수사관(Marshal) 드로우 추적 상태 (첫 차례 2장, 이후 1장)
  const [deckSumAtTurnStart, setDeckSumAtTurnStart] = useState<number>(() => {
    return parseInt(localStorage.getItem('fugitive_deckSumAtTurnStart') || '0', 10);
  });
  const [marshalDrawCount, setMarshalDrawCount] = useState<number>(() => {
    return parseInt(localStorage.getItem('fugitive_marshalDrawCount') || '0', 10);
  });

  // 수사관 추리 보드판 메모 상태 (0~42 숫자 셀별 체크 정보)
  const [notepadNotes, setNotepadNotes] = useState<{ [key: number]: 'none' | 'strikethrough' | 'suspect' }>(() => {
    const saved = localStorage.getItem('fugitive_notepadNotes');
    return saved ? JSON.parse(saved) : {};
  });

  // 마우스 호버한 로그 피드 내 은신처 인덱스 정보 (보드판 동적 하이라이팅 효과용)
  const [hoveredLogIndex, setHoveredLogIndex] = useState<number | null>(null);

  // 수사관이 방금 제출한 추측 데이터 (웹소켓 갱신 시 성공/실패 여부 비교용)
  const [pendingGuess, setPendingGuess] = useState<Array<{ position: number; number: number }> | null>(null);

  // 수사관(Marshal) 액션 로컬 상태
  const [guessTargetIndex, setGuessTargetIndex] = useState<number | null>(null);
  const [singleGuessValue, setSingleGuessValue] = useState<string>('');
  const [isMultiGuessMode, setIsMultiGuessMode] = useState<boolean>(false);
  const [multiGuesses, setMultiGuesses] = useState<string[]>([]);
  
  // 맨헌트 입력 상태
  const [manhuntGuesses, setManhuntGuesses] = useState<{ [key: number]: string }>({});

  // 실시간 작전 피드 로그
  const [actionLog, setActionLog] = useState<string[]>([]);
  const prevPlayerViewRef = useRef<PlayerView | null>(null);

  // 토스트 메시지 헬퍼
  const addToast = (toast: string | { kind?: 'default' | 'success' | 'error' | 'info' | 'warning'; title?: string; message: string }) => {
    const id = Math.random().toString();
    const payload = typeof toast === 'string'
      ? { id, kind: 'default' as const, message: toast }
      : { id, kind: toast.kind || 'default', title: toast.title, message: toast.message };
    setToasts(prev => [...prev, payload]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

  // 로컬 저장소 저장 효과
  useEffect(() => {
    localStorage.setItem('fugitive_playerId', playerId);
  }, [playerId]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    localStorage.setItem('fugitive_serverHost', serverHost);
  }, [serverHost]);

  useEffect(() => {
    localStorage.setItem('fugitive_deckSumAtTurnStart', deckSumAtTurnStart.toString());
  }, [deckSumAtTurnStart]);

  useEffect(() => {
    localStorage.setItem('fugitive_marshalDrawCount', marshalDrawCount.toString());
  }, [marshalDrawCount]);

  useEffect(() => {
    localStorage.setItem('fugitive_notepadNotes', JSON.stringify(notepadNotes));
  }, [notepadNotes]);

  // 테마 전환 감지 및 body 클래스 추가/제거
  useEffect(() => {
    localStorage.setItem('fugitive_theme', theme);
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, [theme]);

  // 언마운트 시 소켓 비활성화
  useEffect(() => {
    return () => {
      if (stompClientRef.current) {
        stompClientRef.current.deactivate();
      }
    };
  }, []);

  // 방장 역할 선택 실시간 방 상태 동기화 및 브로드캐스트
  useEffect(() => {
    if (roomState && playerId === roomState.hostId && connectionStatus === 'CONNECTED' && stompClientRef.current && roomId) {
      if (roomState.hostRole !== hostRole || roomState.guestRole !== (hostRole === 'FUGITIVE' ? 'MARSHAL' : 'FUGITIVE')) {
        stompClientRef.current.publish({
          destination: `/topic/room/${roomId}`,
          body: JSON.stringify({
            ...roomState,
            hostRole: hostRole,
            guestRole: hostRole === 'FUGITIVE' ? 'MARSHAL' : 'FUGITIVE'
          })
        });
      }
    }
  }, [roomState, hostRole, roomId, connectionStatus, playerId]);

  // 게임 로그 실시간 스크롤 하단 고정
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [actionLog]);
  // 도망자 초기 드로우 완료 체크
  useEffect(() => {
    if (!setupDealLocal) return;
    if (setupDealLocal.deck1Queue.length === 0 && setupDealLocal.deck2Queue.length === 0) {
      setSetupDealLocal(null);
      addToast({ kind: 'success', title: '도주 준비 완료', message: '🎉 5장의 카드를 모두 뽑았습니다. 이제 숨을 곳을 찾으세요!' });
    }
  }, [setupDealLocal]);

  // 역할 인트로 카운트다운 타이머
  useEffect(() => {
    if (!showRoleIntro) return;
    if (introCountdown <= 0) {
      setShowRoleIntro(false);
      return;
    }
    const timer = setTimeout(() => {
      setIntroCountdown(prev => prev - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [showRoleIntro, introCountdown]);
  // 실시간 게임 타이머 제어 (게임 진행 중일 때만 동작, 종료 시 정지)
  useEffect(() => {
    if (screen === 'GAME' && playerView && playerView.phase !== 'ENDED') {
      const updateTime = () => {
        const startTimeStr = localStorage.getItem('fugitive_gameStartTime');
        if (startTimeStr) {
          const elapsed = Math.floor((Date.now() - parseInt(startTimeStr, 10)) / 1000);
          setGameSeconds(elapsed);
          localStorage.setItem('fugitive_gameSeconds', elapsed.toString());
        } else {
          setGameSeconds(prev => {
            const next = prev + 1;
            localStorage.setItem('fugitive_gameSeconds', next.toString());
            return next;
          });
        }
      };

      updateTime(); // 즉시 한번 갱신

      const interval = setInterval(updateTime, 1000);

      // 화면이 다시 활성화되거나 포커스를 받았을 때 즉시 시간 보정
      const handleVisibilityOrFocus = () => {
        if (document.visibilityState === 'visible') {
          updateTime();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
      window.addEventListener('focus', handleVisibilityOrFocus);

      return () => {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
        window.removeEventListener('focus', handleVisibilityOrFocus);
      };
    }
  }, [screen, playerView?.phase]);

  // 대기실 등으로 복귀 시 타이머 리셋 (페이지 새로고침 시 초기화 방지를 위해 roomId 존재 여부 확인)
  useEffect(() => {
    if (screen !== 'GAME' && !localStorage.getItem('fugitive_roomId')) {
      setGameSeconds(0);
      localStorage.removeItem('fugitive_gameSeconds');
      localStorage.removeItem('fugitive_gameStartTime');
    }
  }, [screen]);

  // 게임 상태 비교를 통한 자동 로그 피드 생성
  useEffect(() => {
    if (!playerView) {
      prevPlayerViewRef.current = null;
      return;
    }

    const prevView = prevPlayerViewRef.current;
    prevPlayerViewRef.current = playerView;

    const translateRole = (r: string) => r === 'FUGITIVE' ? '도망자 👤' : '수사관 👮';

    const newLogs: string[] = [];

    // 수사관 추측 결과 판정 (성공/실패 피드 출력 및 알림음 재생)
    if (pendingGuess && prevView) {
      const allRevealed = pendingGuess.every(g => playerView.board[g.position]?.revealed);
      
      // 수사 결과가 확정되었는지 여부 (성공했거나, 턴이 넘어갔거나, 게임이 종료된 경우)
      const isResultReady = allRevealed || playerView.currentTurn === 'FUGITIVE' || playerView.phase === 'ENDED';
      
      if (isResultReady) {
        if (allRevealed) {
          if (pendingGuess.length === 1) {
            const g = pendingGuess[0];
            addToast({ kind: 'success', title: '수사 성공!', message: `🎯 정확합니다! ${g.position}번째 은신처는 [${g.number}번]입니다.` });
            newLogs.push(`🎯 수사 성공! ${g.position}번째 은신처는 [${g.number}번]이 맞습니다.`);
            playSynthSound('success');
          } else {
            addToast({ kind: 'success', title: '일괄 수사 성공!', message: '🎯 완벽한 추리입니다! 지목한 은신처를 모두 찾아냈습니다.' });
            newLogs.push(`🎯 일괄 수사 성공! 지목한 은신처들을 모두 찾아냈습니다.`);
            playSynthSound('success');
          }
        } else {
          if (pendingGuess.length === 1) {
            const g = pendingGuess[0];
            addToast({ kind: 'error', title: '수사 실패', message: `❌ 헛짚었습니다. ${g.position}번째 은신처는 [${g.number}번]이 아닙니다.` });
            newLogs.push(`❌ 수사 실패. ${g.position}번째 은신처는 [${g.number}번]이 아닙니다.`);
            playSynthSound('error');
          } else {
            addToast({ kind: 'error', title: '일괄 수사 실패', message: '❌ 지목한 은신처 중 틀린 번호가 섞여 있습니다.' });
            newLogs.push(`❌ 일괄 수사 실패. 지목한 은신처 중 틀린 추측이 있습니다.`);
            playSynthSound('error');
          }
        }
        setPendingGuess(null);
      }
    }

    if (!prevView) {
      setActionLog([
        `🔄 게임 세션에 연결되었습니다.`,
        `당신의 역할은 [${translateRole(playerView.viewer)}]입니다.`,
        `현재 차례: [${translateRole(playerView.currentTurn)}]`
      ]);
      setHasDrawnThisTurn(false);
      // 내 차례 도달 시 벨소리 재생
      if (playerView.viewer === playerView.currentTurn) {
        if (playerView.phase === 'MANHUNT') {
          addToast({ kind: 'info', title: '🚨 맨헌트 발동!', message: '도망자를 잡을 마지막 기회입니다! 남은 은신처를 모두 추측하세요!' });
        } else {
          const isFirstTurnFugitive = playerView.viewer === 'FUGITIVE' && playerView.board.length === 1;
          if (isFirstTurnFugitive) {
            if (setupDealLocal) {
              addToast({ kind: 'info', title: '도주 준비', message: '카드 더미에서 초기 카드 5장을 뽑아주세요.' });
            }
          } else {
            addToast({ kind: 'info', title: '내 턴 시작', message: '턴을 시작합니다. 카드 더미에서 1장을 뽑아주세요.' });
          }
        }
        playSynthSound('turn');
      }
      return;
    }


    // 1. 턴 변경 감지
    if (prevView.currentTurn !== playerView.currentTurn) {
      newLogs.push(`▶️ [${translateRole(playerView.currentTurn)}]의 턴입니다.`);
      setHasDrawnThisTurn(false);
      if (playerView.currentTurn === 'MARSHAL') {
        const currentSum = playerView.deck1Count + playerView.deck2Count + playerView.deck3Count;
        setDeckSumAtTurnStart(currentSum);
        setMarshalDrawCount(0);
      }
      // 로컬 제어 상태 초기화
      setSelectedHideoutCard(null);
      setSelectedSprintCards([]);
      setGuessTargetIndex(null);
      setSingleGuessValue('');

      // 내가 플레이할 턴 차례가 도래하면 맑은 알림차임벨 재생
      if (playerView.viewer === playerView.currentTurn) {
        if (playerView.phase === 'MANHUNT') {
          addToast({ kind: 'info', title: '🚨 맨헌트 발동!', message: '도망자를 잡을 마지막 기회입니다! 남은 은신처를 모두 추측하세요!' });
        } else {
          const isFirstTurnFugitive = playerView.viewer === 'FUGITIVE' && playerView.board.length === 1;
          if (isFirstTurnFugitive) {
            if (setupDealLocal) {
              addToast({ kind: 'info', title: '도주 준비', message: '카드 더미에서 초기 카드 5장을 뽑아주세요.' });
            }
          } else {
            addToast({ kind: 'info', title: '내 턴 시작', message: '턴을 시작합니다. 카드 더미에서 1장을 뽑아주세요.' });
          }
        }
        playSynthSound('turn');
      }
    }

    // 2. 카드 드로우 감지
    const oldHandLen = prevView.hand.length;
    const newHandLen = playerView.hand.length;
    const oldOppHand = prevView.opponentHandSize;
    const newOppHand = playerView.opponentHandSize;

    if (playerView.viewer === 'FUGITIVE') {
      if (newHandLen > oldHandLen && selectedHideoutCard === null) {
        newLogs.push(`👤 카드 더미에서 1장을 뽑았습니다.`);
        setHasDrawnThisTurn(true);
        playSynthSound('draw');
        
        // 카드 드로우 이펙트 트리거
        const newCard = playerView.hand.find(
          c => !prevView.hand.some(oldC => oldC.number === c.number)
        );
        if (newCard) {
          triggerDrawEffect(newCard.number, 'FUGITIVE');
        }
      }
      if (newOppHand > oldOppHand) {
        newLogs.push(`👮 수사관이 카드를 1장 가져갔습니다.`);
      }
    } else {
      if (newOppHand > oldOppHand) {
        newLogs.push(`👤 도망자가 카드를 1장 가져갔습니다.`);
      }
      const deckCountDiff = 
        (prevView.deck1Count - playerView.deck1Count) +
        (prevView.deck2Count - playerView.deck2Count) +
        (prevView.deck3Count - playerView.deck3Count);
      if (deckCountDiff > 0 && newOppHand === oldOppHand) {
        newLogs.push(`👮 카드 더미에서 1장을 뽑았습니다.`);
        setMarshalDrawCount(prev => prev + deckCountDiff);
        playSynthSound('draw');
        
        // 카드 드로우 이펙트 트리거 (수사관이 제외한 카드)
        const newCard = playerView.hand.find(
          c => !prevView.hand.some(oldC => oldC.number === c.number)
        );
        if (newCard) {
          triggerDrawEffect(newCard.number, 'MARSHAL');
        }
      }
    }

    // 3. 은신처 설치 감지
    if (playerView.board.length > prevView.board.length) {
      const addedCount = playerView.board.length - prevView.board.length;
      const lastHideout = playerView.board[playerView.board.length - 1];
      const details = lastHideout.sprintCount > 0 ? ` (👟 도약 ${lastHideout.sprintCount}장 사용)` : '';
      newLogs.push(`👣 도망자가 새로운 은신처 ${addedCount}곳에 숨았습니다.${details}`);
      playSynthSound('success');
    }

    // 4. 발각(공개) 감지 및 수사관의 추측 결과 알림 (도망자 시점 보완)
    let newlyRevealedCount = 0;
    const newlyRevealedDetails: string[] = [];

    playerView.board.forEach((hideout, idx) => {
      const prevHideout = prevView.board[idx];
      if (hideout.revealed && prevHideout && !prevHideout.revealed) {
        newlyRevealedCount++;
        newlyRevealedDetails.push(`은신처${idx}(${hideout.number}번)`);
        newLogs.push(`🚨 ${idx}번째 은신처가 발각되었습니다! (정체: ${hideout.number}번)`);
        // 도망자 시점에서는 경고음을, 수사관 시점에서는 성공음 재생
        if (playerView.viewer === 'FUGITIVE') {
          playSynthSound('error');
        } else {
          playSynthSound('success');
        }
      }
    });

    // 도망자(Fugitive) 시점에서 수사관의 수사 성공/실패 토스트 및 로그 보완
    if (playerView.viewer === 'FUGITIVE') {
      const guess = lastReceivedGuessRef.current;

      // 일반 턴에서 수사관의 차례가 끝나고 도망자의 차례가 시작되었을 때
      if (prevView.currentTurn === 'MARSHAL' && playerView.currentTurn === 'FUGITIVE') {
        if (guess) {
          lastReceivedGuessRef.current = null; // 사용 후 초기화
          const targetNames = guess.targets.map((t: any) => `은신처${t.position}(${t.number}번)`).join(', ');
          const allSucceeded = guess.targets.every((t: any) => playerView.board[t.position]?.revealed);

          if (allSucceeded) {
            addToast({ kind: 'warning', title: '은신처 발각!', message: `🚨 수사관에게 꼬리를 밟혔습니다! (발각: ${targetNames})` });
            newLogs.push(`🚨 수사관이 ${targetNames}을(를) 정확히 찾아냈습니다!`);
          } else {
            addToast({ kind: 'success', title: '위기 모면', message: `💨 수사관이 엉뚱한 곳을 짚었습니다. (대상: ${targetNames})` });
            newLogs.push(`💨 수사관이 ${targetNames}을(를) 헛짚었습니다.`);
            playSynthSound('success');
          }
        } else {
          // fallback (수신 데이터 유실 대비)
          if (newlyRevealedCount > 0) {
            addToast({ kind: 'warning', title: '은신처 발각!', message: `🚨 수사관에게 꼬리를 밟혔습니다! (발각: ${newlyRevealedDetails.join(', ')})` });
          } else {
            addToast({ kind: 'success', title: '위기 모면', message: '💨 수사관이 엉뚱한 곳을 짚었습니다.' });
            newLogs.push(`💨 수사관이 은신처 수사에 실패했습니다.`);
            playSynthSound('success');
          }
        }
      }

      // 맨헌트(최후의 추격) 진행 중 수사관의 추측 성공 감지
      if (prevView.phase === 'MANHUNT' && playerView.phase === 'MANHUNT') {
        if (guess) {
          lastReceivedGuessRef.current = null;
          const targetNames = guess.targets.map((t: any) => `은신처${t.position}(${t.number}번)`).join(', ');
          addToast({ kind: 'warning', title: '최후의 추격 성공당함', message: `🚨 수사관이 내 은신처를 찾아냈습니다: ${targetNames}` });
          newLogs.push(`👮 수사관이 끈질긴 추격 끝에 ${targetNames}을(를) 찾아냈습니다!`);
        } else if (newlyRevealedCount > 0) {
          addToast({ kind: 'warning', title: '최후의 추격 성공당함', message: `🚨 수사관이 내 은신처를 찾아냈습니다: ${newlyRevealedDetails.join(', ')}` });
        }
      }

      // 맨헌트 실패로 게임 종료 및 도망자 승리 시 로그 보정
      if (prevView.phase === 'MANHUNT' && playerView.phase === 'ENDED' && playerView.winner === 'FUGITIVE') {
        if (guess) {
          lastReceivedGuessRef.current = null;
          const targetNames = guess.targets.map((t: any) => `은신처${t.position}(${t.number}번)`).join(', ');
          newLogs.push(`✈️ 수사관이 ${targetNames} 수사에 실패했습니다. 도망자가 무사히 탈출합니다!`);
        }
      }
    }

    // 5. 게임 단계 전환 감지
    if (prevView.phase !== playerView.phase) {
      if (playerView.phase === 'MANHUNT') {
        newLogs.push(`🚨 맨헌트 발동! 수사관의 마지막 맹추격이 시작됩니다!`);
        playSynthSound('turn');
      } else if (playerView.phase === 'ENDED') {
        newLogs.push(`🏁 게임 종료! 🏆 [${translateRole(playerView.winner || '')}]의 승리입니다!`);
        playSynthSound('success');
      }
    }

    if (newLogs.length > 0) {
      setActionLog(prev => [...prev, ...newLogs]);
    }
  }, [playerView]);

  // STOMP 웹소켓 서버 연결 설정
  const handleConnect = (pid: string = playerId) => {
    const activePlayerId = pid || playerId;
    if (!activePlayerId.trim()) {
      addToast('로그인이 필요합니다.');
      playSynthSound('error');
      setScreen('HOME');
      return;
    }

    setConnectionStatus('CONNECTING');

    if (stompClientRef.current) {
      stompClientRef.current.deactivate();
    }

    const token = localStorage.getItem("accessToken") || "";
    const wsUrl = `${wsProto}${cleanHost}/ws`;
    const client = new Client({
      brokerURL: wsUrl,
      connectHeaders: { 
        playerId: activePlayerId,
        Authorization: `Bearer ${token}`
      },
      reconnectDelay: 3000,
      onConnect: () => {
        setConnectionStatus('CONNECTED');
        playSynthSound('success');
        
        // 1. 서버 에러 채널 구독
        client.subscribe('/user/queue/errors', (msg) => {
          try {
            const err: ErrorResponse = JSON.parse(msg.body);
            addToast({ kind: 'error', message: `🚨 [오류] ${translateErrorCode(err.code, err.message)}` });
            playSynthSound('error');
          } catch {
            addToast({ kind: 'error', message: `🚨 통신 오류가 발생했습니다: ${msg.body}` });
            playSynthSound('error');
          }
          // 서버 에러 발생 시 추측 지연 상태 강제 초기화
          setPendingGuess(null);
        });

        // 2. 대기방 생성 결과 채널 구독
        client.subscribe('/user/queue/room.created', (msg) => {
          try {
            const data = JSON.parse(msg.body);
            const newRoomId = data.roomId;

            // 만약 재대결 생성 요청인 경우, 상대방에게도 알리고 대기방으로 동시 이동
            if (isRematchingRef.current) {
              isRematchingRef.current = false;
              const oldRoomId = roomIdRef.current;
              if (oldRoomId) {
                const publishRematchStart = () => {
                  if (client.connected) {
                    client.publish({
                      destination: `/topic/game/${oldRoomId}/guesses`,
                      body: JSON.stringify({
                        type: 'REMATCH_START',
                        newRoomId: newRoomId,
                        guesserId: playerId
                      })
                    });
                  }
                };
                
                // 네트워크 지연 및 일시적인 구독 단절을 감안해 3회 연속 분산 발행하여 신뢰성 보장
                publishRematchStart();
                setTimeout(publishRematchStart, 500);
                setTimeout(publishRematchStart, 1500);
              }
            }

            setRoomId(newRoomId);
            localStorage.setItem('fugitive_roomId', newRoomId);
            subscribeToRoomTopic(client, newRoomId);
            setScreen('WAITING');
            addToast(`대기방이 생성되었습니다! 방 ID: ${newRoomId}`);
            playSynthSound('success');
          } catch (e) {
            console.error("Room parse error", e);
          }
        });

        // 3. 게임 시작 정보 수신 채널 구독
        client.subscribe('/user/queue/game.started', (msg) => {
          try {
            const data = JSON.parse(msg.body);
            // Robust parsing support for both wrapped { view, setupDeal } and flat view payloads
            const view: PlayerView = data.view || data.playerView || (data.viewer ? data : null);
            const setupDeal = data.setupDeal;

            if (!view) {
              console.error("Invalid view in game.started payload", data);
              return;
            }

            setPlayerView(view);
            setScreen('GAME');
            setShowRoleIntro(true);
            setIntroCountdown(5);
            setGameSeconds(0);
            localStorage.setItem('fugitive_gameSeconds', '0');
            localStorage.setItem('fugitive_gameStartTime', Date.now().toString());
            
            const viewerStr = view.viewer === 'FUGITIVE' ? '도망자' : '수사관';
            const turnStr = view.currentTurn === 'FUGITIVE' ? '도망자 👤' : '수사관 👮';
            setActionLog([`🎮 게임이 시작되었습니다! 당신은 [${viewerStr}]입니다. 첫 턴은 [${turnStr}]입니다.`]);
            addToast('게임이 시작되었습니다! 건승을 빕니다.');
            playSynthSound('success');

            // 초기 카드 드로우 연출 상태 초기화
            if (setupDeal) {
              if (view.viewer === 'FUGITIVE') {
                const fixed = setupDeal.fixed || [1, 2, 3, 42];
                const drawn = setupDeal.drawn || [];
                const deck1Queue = drawn.filter((d: any) => d.source === 'DECK_1').map((d: any) => d.card);
                const deck2Queue = drawn.filter((d: any) => d.source === 'DECK_2').map((d: any) => d.card);
                
                setSetupDealLocal({
                  fixed,
                  deck1Queue,
                  deck2Queue,
                  deck1Drawn: [],
                  deck2Drawn: []
                });
              }
            }
          } catch (err) {
            console.error("Error parsing game.started payload", err);
          }
        });

        // 4. 게임 상태 실시간 갱신 채널 구독
        client.subscribe('/user/queue/game.state', (msg) => {
          try {
            const data = JSON.parse(msg.body);
            const view: PlayerView = data.view || data.playerView || (data.viewer ? data : null);
            if (view) {
              setPlayerView(view);
              setScreen('GAME');
            }
          } catch (err) {
            console.error("Error parsing game.state payload", err);
          }
        });

        // 자동 재접속 플로우 실행
        const savedRoomId = localStorage.getItem('fugitive_roomId');
        if (savedRoomId) {
          reconnectRoom(client, savedRoomId);
        } else {
          setScreen('LOBBY');
        }
      },
      onDisconnect: () => {
        setConnectionStatus('DISCONNECTED');
        if (!localStorage.getItem("accessToken")) {
          setScreen('HOME');
        }
      },
      onWebSocketClose: () => {
        setConnectionStatus('DISCONNECTED');
        if (!localStorage.getItem("accessToken")) {
          setScreen('HOME');
        }
      }
    });

    stompClientRef.current = client;
    client.activate();
  };

  // 대기방 토픽 브로드캐스트 구독
  const subscribeToRoomTopic = async (client: Client, rId: string) => {
    if (roomSubscriptionRef.current) {
      roomSubscriptionRef.current.unsubscribe();
    }
    if (gameSubscriptionRef.current) {
      gameSubscriptionRef.current.unsubscribe();
      gameSubscriptionRef.current = null;
    }
    
    const sub = client.subscribe(`/topic/room/${rId}`, (msg) => {
      const state: RoomState = JSON.parse(msg.body);
      
      // 만약 방장이 대기방을 해체(CLOSED)했다면
      if (state.status === 'CLOSED') {
        // 게임이 종료된 상태(ENDED)라면 재대결 초대(REMATCH_START)를 대기하기 위해 로비로 나가지 않고 대기합니다.
        if (playerViewRef.current?.phase !== 'ENDED') {
          addToast('⚠️ 방장이 대기방을 해제하여 방이 해체되었습니다.');
          playSynthSound('error');
          
          // 로컬 상태 완전히 정리하고 로비로 이동
          setRoomId('');
          setRoomState(null);
          setPlayerView(null);
          setDeckSumAtTurnStart(0);
          setMarshalDrawCount(0);
          setNotepadNotes({});
          localStorage.removeItem('fugitive_roomId');
          localStorage.removeItem('fugitive_deckSumAtTurnStart');
          localStorage.removeItem('fugitive_marshalDrawCount');
          localStorage.removeItem('fugitive_notepadNotes');
          localStorage.removeItem('fugitive_gameSeconds');
          localStorage.removeItem('fugitive_gameStartTime');
          
          safeUnsubscribe(roomSubscriptionRef.current);
          roomSubscriptionRef.current = null;
          safeUnsubscribe(gameSubscriptionRef.current);
          gameSubscriptionRef.current = null;
          setScreen('LOBBY');
          return;
        }
      }

      setRoomState(state);

      // 실시간 수신된 닉네임 로컬 캐시 업데이트
      try {
        const cache = JSON.parse(localStorage.getItem("fugitive_nickname_cache") || "{}");
        let updated = false;
        if (state.hostId && state.hostNickname && cache[state.hostId] !== state.hostNickname) {
          cache[state.hostId] = state.hostNickname;
          updated = true;
        }
        if (state.guestId && state.guestNickname && cache[state.guestId] !== state.guestNickname) {
          cache[state.guestId] = state.guestNickname;
          updated = true;
        }
        if (updated) {
          localStorage.setItem("fugitive_nickname_cache", JSON.stringify(cache));
        }
      } catch (e) {
        console.error("Failed to update nickname cache from WebSocket", e);
      }

      if (state.status === 'STARTED' && screenRef.current !== 'GAME') {
        fetchGameView(rId);
      }
    });

    roomSubscriptionRef.current = sub;

    // 수사관의 추측 정보(Failed guess numbers 포함)를 실시간 공유하기 위한 토픽 구독
    const gameSub = client.subscribe(`/topic/game/${rId}/guesses`, (msg) => {
      try {
        const payload = JSON.parse(msg.body);

        // 재대결 관련 실시간 중계 이벤트 처리
        if (payload.type === 'REMATCH_REQUESTED') {
          addToast({ kind: 'info', title: '재대결 신청', message: '🎮 방장이 재대결을 신청했습니다. 새로운 방을 생성 중입니다...' });
        } else if (payload.type === 'REMATCH_START') {
          addToast({ kind: 'success', title: '재대결 시작', message: '⚡ 새 대기방으로 이동합니다!' });
          if (roomSubscriptionRef.current) roomSubscriptionRef.current.unsubscribe();
          if (gameSubscriptionRef.current) gameSubscriptionRef.current.unsubscribe();
          handleJoinRoom(payload.newRoomId);
          return;
        }

        if (payload.guesserId !== playerId) {
          lastReceivedGuessRef.current = payload;
        }
      } catch (e) {
        console.error("Failed to parse guess broadcast", e);
      }
    });
    gameSubscriptionRef.current = gameSub;

    // 대기실 입장 즉시 백엔드로부터 최신 방 상태(RoomState) 동기화 (방장/게스트 상태 즉시 렌더링)
    try {
      const res = await authenticatedFetch(`${httpProto}${cleanHost}/rooms/${rId}`);
      if (res.ok) {
        const state: RoomState = await res.json();
        setRoomState(state);
        
        // 초기화 시 수신된 닉네임 로컬 캐시 업데이트
        try {
          const cache = JSON.parse(localStorage.getItem("fugitive_nickname_cache") || "{}");
          let updated = false;
          if (state.hostId && state.hostNickname && cache[state.hostId] !== state.hostNickname) {
            cache[state.hostId] = state.hostNickname;
            updated = true;
          }
          if (state.guestId && state.guestNickname && cache[state.guestId] !== state.guestNickname) {
            cache[state.guestId] = state.guestNickname;
            updated = true;
          }
          if (updated) {
            localStorage.setItem("fugitive_nickname_cache", JSON.stringify(cache));
          }
        } catch (e) {
          console.error("Failed to update nickname cache from REST", e);
        }
      }
    } catch (e) {
      console.error("Failed to sync room state on subscribe", e);
    }
  };

  // 재접속 시 데이터 복구 함수
  const reconnectRoom = async (client: Client, rId: string) => {
    try {
      const roomRes = await authenticatedFetch(`${httpProto}${cleanHost}/rooms/${rId}`);
      if (!roomRes.ok) {
        throw new Error('Room not found');
      }
      const state: RoomState = await roomRes.json();
      setRoomState(state);
      setRoomId(rId);
      subscribeToRoomTopic(client, rId);

      if (state.status === 'STARTED') {
        const gameRes = await authenticatedFetch(`${httpProto}${cleanHost}/rooms/${rId}/game?playerId=${playerId}`);
        if (gameRes.ok) {
          const view: PlayerView = await gameRes.json();
          setPlayerView(view);
          if (screenRef.current !== 'GAME') {
            setScreen('GAME');
            addToast('진행 중인 세션으로 복구되었습니다!');
            playSynthSound('success');
          }
        } else {
          localStorage.removeItem('fugitive_roomId');
          localStorage.removeItem('fugitive_gameSeconds');
          localStorage.removeItem('fugitive_gameStartTime');
          setScreen('LOBBY');
        }
      } else {
        if (screenRef.current !== 'WAITING') {
          setScreen('WAITING');
          addToast('대기방 세션이 복원되었습니다.');
        }
      }
    } catch {
      localStorage.removeItem('fugitive_roomId');
      localStorage.removeItem('fugitive_gameSeconds');
      localStorage.removeItem('fugitive_gameStartTime');
      setScreen('LOBBY');
    }
  };

  const fetchGameView = async (rId: string) => {
    try {
      const res = await authenticatedFetch(`${httpProto}${cleanHost}/rooms/${rId}/game?playerId=${playerId}`);
      if (res.ok) {
        const data = await res.json();
        const view: PlayerView = data.view || data.playerView || (data.viewer ? data : null);
        if (view) {
          setPlayerView(view);
          setScreen('GAME');
        }
      }
    } catch (e) {
      console.error("Game view fetch fail", e);
    }
  };

  // 로비 및 대기실 액션
  const handleCreateRoom = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED') return;
    playSynthSound('click');
    stompClientRef.current.publish({
      destination: '/app/room/create',
      body: ''
    });
  };

  const handleRematchRequest = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || !roomId) return;
    playSynthSound('click');
    isRematchingRef.current = true;

    // 상대방에게 재대결 신청 브로드캐스트
    stompClientRef.current.publish({
      destination: `/topic/game/${roomId}/guesses`,
      body: JSON.stringify({
        type: 'REMATCH_REQUESTED',
        guesserId: playerId
      })
    });

    // 새 방 만들기 요청
    stompClientRef.current.publish({
      destination: '/app/room/create',
      body: ''
    });
  };

  const handleJoinRoom = (targetRoomId: string) => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || !targetRoomId.trim()) return;
    
    playSynthSound('click');
    setRoomId(targetRoomId);
    localStorage.setItem('fugitive_roomId', targetRoomId);
    
    subscribeToRoomTopic(stompClientRef.current, targetRoomId);

    stompClientRef.current.publish({
      destination: '/app/room/join',
      body: JSON.stringify({ roomId: targetRoomId })
    });

    setScreen('WAITING');
    addToast('대기방 입장을 요청하는 중...');
  };

  const handleToggleReady = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || !roomState) return;
    playSynthSound('click');
    stompClientRef.current.publish({
      destination: '/app/room/ready',
      body: JSON.stringify({ roomId, ready: !roomState.guestReady })
    });
  };

  const handleStartGame = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED') return;
    playSynthSound('success');
    stompClientRef.current.publish({
      destination: '/app/room/start',
      body: JSON.stringify({ roomId, hostRole })
    });
  };

  // 작전 전적 및 통계 가져오기
  const fetchHistory = async (silent: boolean = false) => {
    if (!silent) {
      playSynthSound('click');
    }
    // 1. 전적 목록 조회
    try {
      const res = await authenticatedFetch(`${httpProto}${cleanHost}/players/${playerId}/results`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      }
    } catch (e) {
      console.error("Failed to fetch history results", e);
    }

    // 2. 집계 통계 조회
    try {
      const statsRes = await authenticatedFetch(`${httpProto}${cleanHost}/players/${playerId}/stats`);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
        if (!silent) {
          addToast('작전 기록 및 통계가 최신화되었습니다.');
        }
      } else {
        if (!silent) {
          addToast('서버에서 전적 통계를 불러오지 못했습니다.');
        }
      }
    } catch (e) {
      console.error("Failed to fetch player stats", e);
      if (!silent) {
        addToast('네트워크 오류로 통계를 조회할 수 없습니다.');
      }
    }
  };

  // 로비 화면 진입 시 자동으로 전적(Match History) 목록 최신화 (조용하게 갱신)
  useEffect(() => {
    if (screen === 'LOBBY' && playerId) {
      fetchHistory(true);
    }
  }, [screen, playerId]);

  // 기권하기 액션
  const handleForfeitGame = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || !roomId) return;
    
    playSynthSound('click');
    const confirmForfeit = window.confirm("정말 기권하시겠습니까? 기권 시 즉시 패배 처리됩니다.");
    if (confirmForfeit) {
      stompClientRef.current.publish({
        destination: `/app/game/${roomId}/forfeit`,
        body: ''
      });
      addToast('기권을 선언했습니다.');
    }
  };

  // 게임 행동 발행 액션
  const handleDrawMove = (deck: Deck) => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED') return;
    playSynthSound('click');
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({ type: 'DRAW_CARD', deck })
    });
  };

  const handleFugitiveSetupDraw = (deck: 'DECK_1' | 'DECK_2') => {
    if (!setupDealLocal) return;
    
    if (deck === 'DECK_1') {
      if (setupDealLocal.deck1Queue.length === 0) {
        addToast({ kind: 'warning', message: '⚠️ 덱 1에서 더 이상 뽑을 카드가 없습니다.' });
        return;
      }
      playSynthSound('draw');
      const nextCard = setupDealLocal.deck1Queue[0];
      triggerDrawEffect(nextCard, 'FUGITIVE');
      const newQueue = setupDealLocal.deck1Queue.slice(1);
      const newDrawn = [...setupDealLocal.deck1Drawn, nextCard];
      
      setSetupDealLocal(prev => {
        if (!prev) return null;
        return {
          ...prev,
          deck1Queue: newQueue,
          deck1Drawn: newDrawn
        };
      });
    } else {
      if (setupDealLocal.deck2Queue.length === 0) {
        addToast({ kind: 'warning', message: '⚠️ 덱 2에서 더 이상 뽑을 카드가 없습니다.' });
        return;
      }
      playSynthSound('draw');
      const nextCard = setupDealLocal.deck2Queue[0];
      triggerDrawEffect(nextCard, 'FUGITIVE');
      const newQueue = setupDealLocal.deck2Queue.slice(1);
      const newDrawn = [...setupDealLocal.deck2Drawn, nextCard];
      
      setSetupDealLocal(prev => {
        if (!prev) return null;
        return {
          ...prev,
          deck2Queue: newQueue,
          deck2Drawn: newDrawn
        };
      });
    }
  };

  const handlePlaceHideoutMove = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || selectedHideoutCard === null) return;
    
    if (playerView?.viewer === playerView?.currentTurn && !hasFinishedDrawing) {
      addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 행동할 수 있습니다!' });
      playSynthSound('error');
      return;
    }

    playSynthSound('click');
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({
        type: 'PLACE_HIDEOUT',
        hideout: selectedHideoutCard,
        sprintCards: selectedSprintCards
      })
    });
    // 즉시 로컬 선택 상태 초기화 (stale state 방지)
    setSelectedHideoutCard(null);
    setSelectedSprintCards([]);
  };

  const handlePassMove = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED') return;

    if (playerView?.viewer === playerView?.currentTurn && !hasFinishedDrawing) {
      addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 행동할 수 있습니다!' });
      playSynthSound('error');
      return;
    }

    if (playerView?.board.length === 1) {
      addToast({ kind: 'error', title: '행동 불가', message: '첫 번째 턴에는 무조건 은신처를 하나 이상 배치해야 합니다!' });
      return;
    }
    playSynthSound('click');
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({ type: 'PASS' })
    });
    // 즉시 로컬 선택 상태 초기화
    setSelectedHideoutCard(null);
    setSelectedSprintCards([]);
  };

  const handleGuessMove = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || guessTargetIndex === null || !singleGuessValue.trim()) return;

    if (playerView?.viewer === playerView?.currentTurn && playerView?.phase !== 'MANHUNT' && !hasFinishedDrawing) {
      addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 조사할 수 있습니다!' });
      playSynthSound('error');
      return;
    }

    const parsedNum = parseInt(singleGuessValue, 10);
    if (isNaN(parsedNum)) {
      addToast('올바른 숫자 카드를 입력하세요.');
      playSynthSound('error');
      return;
    }

    playSynthSound('click');
    setPendingGuess([{ position: guessTargetIndex, number: parsedNum }]);
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({
        type: 'GUESS',
        targets: [{ position: guessTargetIndex, number: parsedNum }]
      })
    });
    stompClientRef.current.publish({
      destination: `/topic/game/${roomId}/guesses`,
      body: JSON.stringify({
        targets: [{ position: guessTargetIndex, number: parsedNum }],
        guesserId: playerId
      })
    });
  };

  const handleMultiGuessMove = () => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED' || !playerView) return;

    if (playerView.viewer === playerView.currentTurn && playerView.phase !== 'MANHUNT' && !hasFinishedDrawing) {
      addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 조사할 수 있습니다!' });
      playSynthSound('error');
      return;
    }

    const targets: { position: number; number: number }[] = [];
    let isValid = true;

    playerView.board.forEach((h, index) => {
      if (!h.revealed) {
        const unrevealedItems = playerView.board.map((hd, idx) => ({ hd, idx })).filter(item => !item.hd.revealed);
        const localIdx = unrevealedItems.findIndex(item => item.idx === index);
        const valStr = multiGuesses[localIdx];

        if (valStr && valStr.trim() !== '') {
          const val = parseInt(valStr, 10);
          if (isNaN(val)) {
            isValid = false;
          } else {
            targets.push({ position: index, number: val });
          }
        }
      }
    });

    if (!isValid) {
      addToast('올바른 숫자 카드를 채워주세요.');
      playSynthSound('error');
      return;
    }
    if (targets.length === 0) {
      addToast('추측할 은신처 번호를 최소 1개 이상 입력해주세요.');
      playSynthSound('error');
      return;
    }

    playSynthSound('click');
    setPendingGuess(targets);
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({
        type: 'GUESS',
        targets
      })
    });
    stompClientRef.current.publish({
      destination: `/topic/game/${roomId}/guesses`,
      body: JSON.stringify({
        targets,
        guesserId: playerId
      })
    });

    setIsMultiGuessMode(false);
    setMultiGuesses([]);
  };

  const handleManhuntGuessSubmit = (targetIdx: number) => {
    if (!stompClientRef.current || connectionStatus !== 'CONNECTED') return;

    const valStr = manhuntGuesses[targetIdx];
    const val = parseInt(valStr, 10);

    if (isNaN(val)) {
      addToast('올바른 카드를 지정해 주세요.');
      playSynthSound('error');
      return;
    }

    playSynthSound('click');
    setPendingGuess([{ position: targetIdx, number: val }]);
    stompClientRef.current.publish({
      destination: `/app/game/${roomId}/move`,
      body: JSON.stringify({
        type: 'MANHUNT_GUESS',
        target: { position: targetIdx, number: val }
      })
    });
    stompClientRef.current.publish({
      destination: `/topic/game/${roomId}/guesses`,
      body: JSON.stringify({
        targets: [{ position: targetIdx, number: val }],
        guesserId: playerId
      })
    });

    setManhuntGuesses(prev => {
      const next = { ...prev };
      delete next[targetIdx];
      return next;
    });
  };

  const handleLeaveRoom = () => {
    // 1. 방을 떠나기 전 다른 플레이어에게 이탈 사실을 알림 (STOMP 토픽 발행 우회 기법)
    if (stompClientRef.current && connectionStatus === 'CONNECTED' && roomState && roomId) {
      const isHost = playerId === roomState.hostId;
      if (isHost) {
        // 방장이 나가면 방을 폭파시킵니다 (CLOSED 상태 전송)
        stompClientRef.current.publish({
          destination: `/topic/room/${roomId}`,
          body: JSON.stringify({
            ...roomState,
            status: 'CLOSED'
          })
        });
      } else {
        // 게스트가 나가면 게스트 정보만 제거한 방 상태를 전송하여 방장 화면에서 사라지게 합니다
        stompClientRef.current.publish({
          destination: `/topic/room/${roomId}`,
          body: JSON.stringify({
            ...roomState,
            guestId: null,
            guestReady: false
          })
        });
      }
    }

    // 2. 구독 해제 및 로컬 상태 초기화
    if (roomSubscriptionRef.current) {
      roomSubscriptionRef.current.unsubscribe();
      roomSubscriptionRef.current = null;
    }
    if (gameSubscriptionRef.current) {
      gameSubscriptionRef.current.unsubscribe();
      gameSubscriptionRef.current = null;
    }
    
    localStorage.removeItem('fugitive_roomId');
    localStorage.removeItem('fugitive_deckSumAtTurnStart');
    localStorage.removeItem('fugitive_marshalDrawCount');
    localStorage.removeItem('fugitive_notepadNotes');
    localStorage.removeItem('fugitive_gameSeconds');
    localStorage.removeItem('fugitive_gameStartTime');
    setRoomId('');
    setRoomState(null);
    setPlayerView(null);
    setDeckSumAtTurnStart(0);
    setMarshalDrawCount(0);
    setNotepadNotes({});
    setScreen('LOBBY');
    if (playerViewRef.current?.phase !== 'ENDED') {
      addToast('대기방에서 퇴장했습니다.');
    }
    playSynthSound('click');
  };

  // UI 연산 헬퍼
  const getLastHideoutNumber = (): number => {
    if (!playerView || playerView.board.length === 0) return 0;
    const last = playerView.board[playerView.board.length - 1];
    return last.number ?? 0;
  };

  // 보드게임 격자 레이아웃 좌표 계산을 위한 헬퍼 함수
  const getPositionForCard = (index: number) => {
    let cardCount = 0;
    let r = 1;
    while (true) {
      const cardsInRow = (r % 2 === 1) ? 5 : 4;
      if (index < cardCount + cardsInRow) {
        const positionInRow = index - cardCount;
        const col = (r % 2 === 1) 
          ? (2 * positionInRow + 1) // 홀수 행: 1, 3, 5, 7, 9
          : (2 * positionInRow + 2); // 짝수 행: 2, 4, 6, 8 (홀수 행 카드 사이의 간격에 위치)
        return { row: r, col };
      }
      cardCount += cardsInRow;
      r++;
    }
  };

  const getPositionForConnector = (index: number) => {
    const posA = getPositionForCard(index);
    const posB = getPositionForCard(index + 1);
    if (posA.row === posB.row) {
      return {
        row: posA.row,
        col: (posA.col + posB.col) / 2
      };
    } else {
      if (posA.row % 2 === 1) {
        // 홀수 행 -> 짝수 행: 짝수 행의 Column 1에 배치
        return {
          row: posA.row + 1,
          col: 1
        };
      } else {
        // 짝수 행 -> 홀수 행: 짝수 행의 Column 9에 배치
        return {
          row: posA.row,
          col: 9
        };
      }
    }
  };



  const copyToClipboard = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    playSynthSound('success');
    setTimeout(() => setCopied(false), 1500);
  };

  // 도망자 첫 턴 감지 (도망자는 5장 시작 카드 중 드로우 없이 즉시 은신처 배치/패스를 진행합니다)
  const isFugitiveFirstTurn = playerView ? (
    playerView.viewer === 'FUGITIVE' &&
    playerView.currentTurn === 'FUGITIVE' &&
    playerView.deck1Count === 8 &&
    playerView.deck2Count === 12 &&
    playerView.deck3Count === 13
  ) : false;

  // 수사관이 턴 당 뽑아야 하는 카드 수 (첫 턴은 2장, 이후는 1장)
  const requiredDraws = (playerView && playerView.viewer === 'MARSHAL') 
    ? (deckSumAtTurnStart === 33 ? 2 : 1) 
    : 1;

  // 턴 진행에 필요한 카드 뽑기 단계를 충족했는지 여부
  const hasFinishedDrawing = playerView?.viewer === 'FUGITIVE'
    ? (setupDealLocal ? false : (hasDrawnThisTurn || isFugitiveFirstTurn))
    : (marshalDrawCount >= requiredDraws);

  const isCanDraw1 = !!playerView && (setupDealLocal
    ? (setupDealLocal.deck1Queue.length > 0)
    : (playerView.deck1Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT'));

  const isCanDraw2 = !!playerView && (setupDealLocal
    ? (setupDealLocal.deck2Queue.length > 0)
    : (playerView.deck2Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT'));

  const isCanDraw3 = !!playerView && (!setupDealLocal &&
    (playerView.deck3Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT'));

  const totalSprintPower = selectedSprintCards.reduce((sum, c) => sum + getSprintValue(c), 0);
  const movementDistance = selectedHideoutCard !== null ? (selectedHideoutCard - getLastHideoutNumber()) : 0;
  const footprintsRequired = Math.max(0, movementDistance - 3);
  const isSprintPowerSufficient = totalSprintPower >= footprintsRequired;

  // 도망자 다음 카드 이동 조건 체크
  const isDraftValid = selectedHideoutCard !== null && selectedHideoutCard > getLastHideoutNumber() && isSprintPowerSufficient;

  const formatDate = (isoStr: string) => {
    try {
      const date = new Date(isoStr);
      return date.toLocaleString();
    } catch {
      return isoStr;
    }
  };



  return (
    <div className="game-container">
      {/* 토스트 알림바 */}
      <div className="toast-container">
        {toasts.map(toast => {
          const icon = toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : toast.kind === 'warning' ? '!' : 'i';
          if (toast.title) {
            return (
              <div key={toast.id} className={`toast toast-${toast.kind}`}>
                <div className="toast-header">
                  <span className="toast-icon">{icon}</span>
                  <strong className="toast-title">{toast.title}</strong>
                </div>
                <div className="toast-message" style={{ paddingLeft: '2.75rem' }}>{toast.message}</div>
              </div>
            );
          } else {
            return (
              <div key={toast.id} className={`toast toast-${toast.kind}`} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1.1rem 1.35rem' }}>
                <span className="toast-icon" style={{ margin: 0 }}>{icon}</span>
                <div className="toast-message" style={{ margin: 0 }}>{toast.message}</div>
              </div>
            );
          }
        })}
      </div>

      {/* 메인 뷰포트 래퍼 */}
      <div className="tabletop-wrapper">
        {/* 헤더: Toss 스타일 슬림 내비게이션 바 */}
        <header className="cardboard-header">
          <div className="header-title-container" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.8rem' }}>
            <img 
              src="/images/chase.png" 
              alt="Logo" 
              style={{ width: '60px', height: '60px', borderRadius: '12px', objectFit: 'cover' }} 
            />
            <h1 style={{ margin: 0, lineHeight: 1.1 }}>FUGITIVE</h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', zIndex: 20 }}>
            {/* 연결 상태 표시 */}
            <div className={`connection-badge ${connectionStatus.toLowerCase()}`}>
              <span className="dot" />
              <span>
                {connectionStatus === 'CONNECTED' ? '연결됨' : connectionStatus === 'CONNECTING' ? '연결 중' : '오프라인'}
              </span>
            </div>
          </div>
        </header>

        {/* 1. 홈 화면: 플레이어 접속 (Toss 로그인 카드 스타일) */}
        {screen === 'HOME' && (
          <div className="glass-panel" style={{ maxWidth: '440px', margin: '4rem auto', padding: '2.5rem', textAlign: 'center' }}>
            {/* 나노 바나나(Imagen 3)로 고해상도 생성된 수사관 및 도망자 추격 일러스트 */}
            <img 
              src="/images/chase.png" 
              alt="Fugitive Chase" 
              style={{ 
                width: '160px', 
                height: '160px', 
                borderRadius: '24px', 
                objectFit: 'cover',
                margin: '0 auto 1.5rem', 
                display: 'block',
                boxShadow: 'none',
                border: 'none'
              }} 
            />

            <div style={{ padding: '0.2rem 0', marginBottom: '2rem' }}>
              <h1 style={{ fontSize: '2.6rem', fontWeight: 800, color: 'var(--primary)', letterSpacing: '-0.04em' }}>FUGITIVE</h1>
            </div>

            <button 
              className="btn w-full" 
              style={{ 
                padding: '0.9rem', 
                fontSize: '1rem', 
                borderRadius: '12px', 
                background: '#FEE500', 
                color: '#191919',
                fontWeight: 'bold',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                cursor: 'pointer',
                boxShadow: 'var(--shadow-sm)',
                transition: 'all 0.15s ease'
              }} 
              onClick={() => {
                playSynthSound('click');
                window.location.href = `${httpProto}${cleanHost}/auth/kakao/login?prompt=login`;
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M12 3c-4.97 0-9 3.185-9 7.11 0 2.508 1.642 4.717 4.148 5.922-.164.606-.59 2.183-.676 2.518-.107.414.143.408.3.303.123-.082 1.956-1.328 2.736-1.854.478.077.973.12 1.482.12 4.97 0 9-3.186 9-7.11S16.97 3 12 3z"/>
              </svg>
              카카오 로그인
            </button>
          </div>
        )}

        {screen === 'LOBBY' && (
          <div className="grid-layout" style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '90%' }}>
            {/* 왼쪽: 게임 방 생성 및 입장 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="glass-panel">
                <h2 style={{ marginBottom: '0.8rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>게임 로비</h2>
                <p style={{ marginBottom: '1.5rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <span>
                    반갑습니다, <strong style={{ color: 'var(--primary)' }}>{nickname || playerId}</strong>님.
                  </span>
                  <button 
                    className="btn btn-secondary" 
                    style={{ padding: '0.3rem 0.7rem', fontSize: '0.72rem', borderRadius: '6px' }}
                    onClick={handleLogoutCleanly}
                  >
                    🚪 로그아웃
                  </button>
                </p>

                <div style={{ display: 'flex', gap: '1rem', flexDirection: 'column' }}>
                  <button 
                    className="btn btn-primary" 
                    style={{ fontSize: '0.95rem', padding: '0.9rem', borderRadius: '12px' }}
                    onClick={handleCreateRoom}
                  >
                    📡 새로운 게임 방 만들기
                  </button>

                  <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden', marginTop: '0.8rem', background: 'var(--bg-card)' }}>
                    <input 
                      type="text" 
                      className="cyber-input" 
                      style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}
                      placeholder="초대 코드(Room ID) 입력" 
                      id="joinRoomInput"
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          handleJoinRoom((e.target as HTMLInputElement).value);
                        }
                      }}
                    />
                    <button 
                      className="btn btn-secondary" 
                      style={{ borderRadius: 0, padding: '0 1.8rem', whiteSpace: 'nowrap' }}
                      onClick={() => {
                        const input = document.getElementById('joinRoomInput') as HTMLInputElement;
                        if (input) handleJoinRoom(input.value);
                      }}
                    >
                      방 입장
                    </button>
                  </div>
                </div>
              </div>

              {/* 개인 전적 통계 (승률 대시보드) */}
              {stats && (
                <div className="glass-panel" style={{ animation: 'fadeIn 0.4s ease-out' }}>
                  <h2 style={{ marginBottom: '1.2rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>🏆 개인 전적 통계</h2>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1.2rem', marginBottom: '1.5rem' }}>
                    {/* Overall Stats */}
                    <div style={{ background: 'var(--bg-page)', padding: '1rem 1.2rem', borderRadius: '12px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                      <span className="cyber-label">전체 승률</span>
                      <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', margin: '0.4rem 0' }}>
                        {Math.round(stats.winRate * 100)}%
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {stats.totalGames}전 {stats.wins}승 {stats.losses}패
                      </div>
                    </div>

                    {/* Fugitive Stats */}
                    <div style={{ background: 'var(--bg-page)', padding: '1rem 1.2rem', borderRadius: '12px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                      <span className="cyber-label">👤 도망자 전적</span>
                      <div style={{ fontSize: '1.6rem', fontWeight: 800, color: stats.asFugitive.games > 0 && (stats.asFugitive.wins / stats.asFugitive.games) >= 0.5 ? 'var(--success)' : 'var(--danger)', margin: '0.4rem 0' }}>
                        {stats.asFugitive.games > 0 ? `${Math.round((stats.asFugitive.wins / stats.asFugitive.games) * 100)}%` : '0%'}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {stats.asFugitive.games}전 {stats.asFugitive.wins}승 {stats.asFugitive.losses}패
                      </div>
                    </div>

                    {/* Marshal Stats */}
                    <div style={{ background: 'var(--bg-page)', padding: '1rem 1.2rem', borderRadius: '12px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                      <span className="cyber-label">👮 수사관 전적</span>
                      <div style={{ fontSize: '1.6rem', fontWeight: 800, color: stats.asMarshal.games > 0 && (stats.asMarshal.wins / stats.asMarshal.games) >= 0.5 ? 'var(--success)' : 'var(--danger)', margin: '0.4rem 0' }}>
                        {stats.asMarshal.games > 0 ? `${Math.round((stats.asMarshal.wins / stats.asMarshal.games) * 100)}%` : '0%'}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {stats.asMarshal.games}전 {stats.asMarshal.wins}승 {stats.asMarshal.losses}패
                      </div>
                    </div>
                  </div>

                  {/* Visual Win Rate Progress Bars */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '4px', fontWeight: 600 }}>
                        <span style={{ color: 'var(--text-primary)' }}>👤 도망자 승률</span>
                        <span style={{ color: stats.asFugitive.games > 0 && (stats.asFugitive.wins / stats.asFugitive.games) >= 0.5 ? 'var(--success)' : 'var(--danger)' }}>
                          {stats.asFugitive.games > 0 ? Math.round((stats.asFugitive.wins / stats.asFugitive.games) * 100) : 0}%
                        </span>
                      </div>
                      <div style={{ height: '8px', background: 'var(--border-color)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div 
                          style={{ 
                            height: '100%', 
                            background: stats.asFugitive.games > 0 && (stats.asFugitive.wins / stats.asFugitive.games) >= 0.5 ? 'var(--success)' : 'var(--danger)', 
                            width: `${stats.asFugitive.games > 0 ? (stats.asFugitive.wins / stats.asFugitive.games) * 100 : 0}%`,
                            transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)'
                          }} 
                        />
                      </div>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '4px', fontWeight: 600 }}>
                        <span style={{ color: 'var(--text-primary)' }}>👮 수사관 승률</span>
                        <span style={{ color: stats.asMarshal.games > 0 && (stats.asMarshal.wins / stats.asMarshal.games) >= 0.5 ? 'var(--success)' : 'var(--danger)' }}>
                          {stats.asMarshal.games > 0 ? Math.round((stats.asMarshal.wins / stats.asMarshal.games) * 100) : 0}%
                        </span>
                      </div>
                      <div style={{ height: '8px', background: 'var(--border-color)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div 
                          style={{ 
                            height: '100%', 
                            background: stats.asMarshal.games > 0 && (stats.asMarshal.wins / stats.asMarshal.games) >= 0.5 ? 'var(--success)' : 'var(--danger)', 
                            width: `${stats.asMarshal.games > 0 ? (stats.asMarshal.wins / stats.asMarshal.games) * 100 : 0}%`,
                            transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)'
                          }} 
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 최근 전적 */}
              <div className="glass-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                  <h2 style={{ border: 'none', padding: 0, margin: 0 }}>최근 전적</h2>
                  <button className="btn btn-secondary" style={{ padding: '0.35rem 0.8rem', fontSize: '0.75rem' }} onClick={() => fetchHistory()}>
                    🔄 전적 새로고침
                  </button>
                </div>

                {history.length > 0 ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="cyber-table">
                      <thead>
                        <tr>
                          <th>승리 여부</th>
                          <th>내 역할</th>
                          <th>대전 상대</th>
                          <th>기록 시간</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map(record => {
                          const isWinner = record.winnerPlayerId === playerId;
                          const myRoleLabel = getMyRoleLabel(record);
                          const opponentDisplayName = getOpponentDisplayName(record);
                          return (
                            <tr key={record.roomId}>
                              <td style={{ color: isWinner ? 'var(--success)' : 'var(--danger)', fontWeight: 'bold' }}>
                                {isWinner ? '승리' : '패배'}
                              </td>
                              <td>{myRoleLabel}</td>
                              <td>{opponentDisplayName}</td>
                              <td style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                                {formatDate(record.endedAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    최근 게임 전적이 없습니다. 첫 게임을 시작해 보세요!
                  </div>
                )}
              </div>
            </div>


          </div>
        )}

        {/* 3. 대기실 화면 */}
        {screen === 'WAITING' && (
          <div className="glass-panel" style={{ maxWidth: '600px', margin: '3rem auto' }}>
            <h2 style={{ marginBottom: '1.5rem', textAlign: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>게임 대기실</h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', marginBottom: '2rem' }}>
              {playerId === roomState?.hostId && (
                <div>
                  <span className="cyber-label" style={{ textAlign: 'center', display: 'block' }}>방 초대 코드</span>
                  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-page)', padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <code style={{ flex: 1, fontSize: '0.85rem', color: 'var(--primary)', overflowX: 'auto', whiteSpace: 'nowrap', fontWeight: 'bold' }}>
                      {roomId}
                    </code>
                    <button 
                      className="btn btn-secondary" 
                      style={{ padding: '0.35rem 0.8rem', fontSize: '0.75rem', marginLeft: '1rem' }}
                      onClick={copyToClipboard}
                    >
                      코드 복사
                    </button>
                    {copied && <span className="copied-tip">복사 완료!</span>}
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.2rem', marginTop: '1rem' }}>
                {/* Host Card */}
                <div className="glass-panel" style={{ background: 'var(--bg-page)', textAlign: 'center', border: '1px solid var(--border-color)', padding: '1.5rem' }}>
                  <span className="cyber-label">방장 (Host)</span>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--text-primary)', marginTop: '0.5rem' }}>
                    {(() => {
                      const state = roomState as any;
                      const name = state?.hostNickname || state?.hostName || state?.hostPlayerNickname || state?.hostPlayerName;
                      if (roomState?.hostId === playerId) return `${nickname || name || roomState?.hostId} 👑`;
                      return `${name || roomState?.hostId} 👑`;
                    })()}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--primary)', marginTop: '0.5rem', fontWeight: 'bold' }}>
                    {roomState?.hostRole ? (
                      `역할: ${roomState.hostRole === 'FUGITIVE' ? '👤 도망자' : '👮 수사관'}`
                    ) : (
                      playerId === roomState?.hostId
                        ? `선택한 역할: ${hostRole === 'FUGITIVE' ? '👤 도망자' : '👮 수사관'}`
                        : '역할: 방장이 선택 중...'
                    )}
                  </div>
                </div>

                {/* Guest Card */}
                <div className="glass-panel" style={{ background: 'var(--bg-page)', textAlign: 'center', border: '1px solid var(--border-color)', padding: '1.5rem' }}>
                  <span className="cyber-label">참가자 (Guest)</span>
                  {roomState?.guestId ? (
                    <>
                      <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--text-primary)', marginTop: '0.5rem' }}>
                        {(() => {
                          const state = roomState as any;
                          const name = state?.guestNickname || state?.guestName || state?.guestPlayerNickname || state?.guestPlayerName;
                          if (roomState?.guestId === playerId) return nickname || name || roomState?.guestId;
                          return name || roomState?.guestId;
                        })()}
                      </div>
                      {roomState?.guestRole && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: '0.5rem', fontWeight: 'bold' }}>
                          역할: {roomState.guestRole === 'FUGITIVE' ? '👤 도망자' : '👮 수사관'}
                        </div>
                      )}
                      <div style={{ 
                        display: 'inline-block', 
                        marginTop: '0.6rem', 
                        padding: '0.25rem 0.8rem', 
                        borderRadius: '12px', 
                        fontSize: '0.75rem', 
                        fontWeight: 'bold', 
                        backgroundColor: roomState.guestReady ? 'var(--success-bg)' : 'var(--danger-bg)',
                        color: roomState.guestReady ? 'var(--success)' : 'var(--danger)',
                        border: roomState.guestReady ? '1px solid var(--success)' : '1px dashed var(--danger)'
                      }}>
                        {roomState.guestReady ? '✓ 준비 완료' : '⌛ 준비 대기 중'}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: '1.2rem', fontSize: '0.85rem' }}>
                      다른 플레이어가 참여하기를 <br /> 대기하는 중...
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 역할 선택 UI (방장 전용 / 게스트 안내) */}
            <div className="glass-panel" style={{ background: 'var(--bg-page)', padding: '1.2rem', border: '1px solid var(--border-color)', borderRadius: '16px', marginBottom: '1.5rem', marginTop: '1.5rem' }}>
              {playerId === roomState?.hostId ? (
                <div>
                  <span className="cyber-label" style={{ display: 'block', marginBottom: '0.8rem', textAlign: 'center', fontWeight: 'bold' }}>
                    🎮 내 역할 선택 (게스트는 반대 역할로 자동 지정)
                  </span>
                  <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center' }}>
                    <button
                      className={`btn ${hostRole === 'FUGITIVE' ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ flex: 1, padding: '0.65rem 1rem', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontWeight: 'bold' }}
                      onClick={() => {
                        playSynthSound('click');
                        setHostRole('FUGITIVE');
                      }}
                    >
                      👤 도망자 (FUGITIVE)
                    </button>
                    <button
                      className={`btn ${hostRole === 'MARSHAL' ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ flex: 1, padding: '0.65rem 1rem', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontWeight: 'bold' }}
                      onClick={() => {
                        playSynthSound('click');
                        setHostRole('MARSHAL');
                      }}
                    >
                      👮 수사관 (MARSHAL)
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', fontSize: '0.88rem', color: 'var(--text-secondary)', padding: '0.2rem 0' }}>
                  💡 <span style={{ fontWeight: 'bold', color: 'var(--primary)' }}>방장</span>이 역할을 선택하고 게임을 시작하면 저는 자동으로 <span style={{ fontWeight: 'bold', color: 'var(--warning)' }}>반대 역할</span>이 됩니다.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              {/* 게스트 준비 완료 토글 */}
              {playerId === roomState?.guestId && (
                <button 
                  className={`btn ${roomState.guestReady ? 'btn-secondary' : 'btn-primary'} w-full`}
                  style={{ borderRadius: '12px' }}
                  onClick={handleToggleReady}
                >
                  {roomState.guestReady ? '준비 취소' : '준비 완료'}
                </button>
              )}

              {/* 방장 게임 시작 버튼 */}
              {playerId === roomState?.hostId && (
                <button 
                  className="btn btn-primary w-full"
                  style={{ borderRadius: '12px' }}
                  onClick={handleStartGame}
                  disabled={!roomState?.guestId || !roomState?.guestReady}
                >
                  {!roomState?.guestId 
                    ? '플레이어 대기 중...' 
                    : !roomState?.guestReady 
                      ? '상대방 플레이어가 준비 대기 중입니다...' 
                      : '⚡ 게임 시작'}
                </button>
              )}

              <button 
                className="btn btn-secondary" 
                style={{ borderRadius: '12px', whiteSpace: 'nowrap', flexShrink: 0 }} 
                onClick={handleLeaveRoom}
              >
                방 나가기
              </button>
            </div>
          </div>
        )}

        {/* 4. 활성화된 작전 게임판 화면 */}
        {screen === 'GAME' && playerView && (
          <div>
            {/* 역할 소개 인트로 오버레이 */}
            {showRoleIntro && (
              <div className="overlay-screen" style={{ zIndex: 3000, background: 'rgba(7, 10, 19, 0.98)', backdropFilter: 'blur(20px)' }}>
                <div className="glass-panel" style={{
                  padding: '3rem 2.5rem',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-card)',
                  maxWidth: '520px',
                  width: '90%',
                  borderRadius: '24px',
                  textAlign: 'center',
                  boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
                  animation: 'scaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
                }}>
                  {playerView.viewer === 'FUGITIVE' ? (
                    <>
                      <span style={{ fontSize: '4.5rem', display: 'block', marginBottom: '1rem', animation: 'pulse 2s infinite' }}>👤</span>
                      <h2 style={{ fontSize: '2.2rem', color: 'var(--success)', border: 'none', padding: 0, margin: '0 0 1rem 0', fontWeight: '800', letterSpacing: '-0.02em' }}>
                        도망자 (FUGITIVE)
                      </h2>
                      <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '2rem' }}>
                        당신의 목표는 수사관의 추적을 따돌리고 최종 목적지인 42번 은신처를 안전하게 설치하여 탈출하는 것입니다.
                      </p>
                      <div style={{ background: 'var(--bg-page)', borderRadius: '16px', padding: '1.2rem', border: '1px solid var(--border-color)', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '0.8rem', marginBottom: '2.5rem' }}>
                        <h4 style={{ fontSize: '0.9rem', margin: 0, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.6rem' }}>
                          💡 도망자 가이드
                        </h4>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <div>• 카드를 내어 순서대로 증가하는 은신처를 설치합니다.</div>
                          <div>• 직전 은신처와의 번호 차이는 기본 최대 3입니다.</div>
                          <div>• 더 멀리 이동하려면 발자국 카드(도약)를 추가로 같이 내야 합니다.</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: '4.5rem', display: 'block', marginBottom: '1rem', animation: 'pulse 2s infinite' }}>👮</span>
                      <h2 style={{ fontSize: '2.2rem', color: 'var(--primary)', border: 'none', padding: 0, margin: '0 0 1rem 0', fontWeight: '800', letterSpacing: '-0.02em' }}>
                        수사관 (MARSHAL)
                      </h2>
                      <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '2rem' }}>
                        당신의 목표는 도망자가 숨겨둔 모든 은신처 번호를 추리하여 도망자를 검거(체포)하는 것입니다.
                      </p>
                      <div style={{ background: 'var(--bg-page)', borderRadius: '16px', padding: '1.2rem', border: '1px solid var(--border-color)', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '0.8rem', marginBottom: '2.5rem' }}>
                        <h4 style={{ fontSize: '0.9rem', margin: 0, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.6rem' }}>
                          💡 수사관 가이드
                        </h4>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <div>• 도망자가 설치한 번호를 하나씩 또는 일괄로 추측합니다.</div>
                          <div>• 일괄 수색 시 하나라도 번호가 다르면 실패 처리됩니다.</div>
                          <div>• 도망자가 42번 은신처를 설치하기 전에 모든 은신처를 찾아내세요.</div>
                        </div>
                      </div>
                    </>
                  )}
                  
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
                    <button
                      className="btn btn-primary"
                      style={{ width: '100%', padding: '0.9rem', fontSize: '1rem', borderRadius: '12px', fontWeight: 'bold' }}
                      onClick={() => {
                        playSynthSound('click');
                        setShowRoleIntro(false);
                      }}
                    >
                      작전 개시
                    </button>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                      {introCountdown}초 후 자동으로 게임이 시작됩니다...
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* 게임 결과 오버레이 (Toss 스타일 모달 오버레이) */}
            {playerView.phase === 'ENDED' && (
              <div className="overlay-screen">
                <div className="glass-panel" style={{ padding: '3rem 2.5rem', border: '1px solid var(--border-color)', background: 'var(--bg-card)', maxWidth: '460px', width: '90%', borderRadius: '24px', textAlign: 'center', boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)', animation: 'scaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                  {(() => {
                    const isMeWinner = playerView.winner === playerView.viewer;
                    return (
                      <>
                        <span style={{ fontSize: '3.5rem', display: 'block', marginBottom: '1rem' }}>
                          {isMeWinner ? '🎉' : '☠️'}
                        </span>
                        <h2 className={`overlay-title ${playerView.winner}`} style={{ fontSize: '2rem', border: 'none', padding: 0, color: isMeWinner ? 'var(--success)' : 'var(--danger)' }}>
                          {isMeWinner ? '게임 승리!' : '게임 패배...'}
                        </h2>
                        <div style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', marginTop: '0.4rem', marginBottom: '2rem' }}>
                          {isMeWinner ? '축하합니다! 완벽한 승리를 쟁취하셨습니다.' : '아쉽지만 상대방에게 패배했습니다.'}
                        </div>

                        {/* 경기 요약 정보 (Toss 영수증 스타일) */}
                        <div style={{ background: 'var(--bg-page)', borderRadius: '16px', padding: '1.2rem', border: '1px solid var(--border-color)', textAlign: 'left', marginBottom: '2.5rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                          <h4 style={{ fontSize: '0.88rem', margin: 0, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.6rem', marginBottom: '0.2rem' }}>
                            📊 최종 경기 리포트
                          </h4>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>나의 역할</span>
                            <span style={{ fontWeight: 'bold' }}>{playerView.viewer === 'FUGITIVE' ? '도망자 👤' : '수사관 👮'}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>최종 우승</span>
                            <span style={{ fontWeight: 'bold', color: playerView.winner === 'FUGITIVE' ? 'var(--success)' : 'var(--primary)' }}>
                              {playerView.winner === 'FUGITIVE' ? '도망자 (탈출)' : '수사관 (체포)'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>방문한 은신처 개수</span>
                            <span style={{ fontWeight: 'bold' }}>{playerView.board.length}곳</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>최종 은신처 위치</span>
                            <span style={{ fontWeight: 'bold' }}>{getLastHideoutNumber()}번 카드</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>경기 시간</span>
                            <span style={{ fontWeight: 'bold' }}>{formatGameTime(gameSeconds)}</span>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', width: '100%', marginTop: '1.5rem' }}>
                          {playerId === roomState?.hostId ? (
                            <button 
                              className="btn btn-primary" 
                              style={{ padding: '0.8rem 2.5rem', fontSize: '1.05rem', borderRadius: '12px', width: '100%', fontWeight: 'bold', background: 'var(--success)' }} 
                              onClick={handleRematchRequest}
                            >
                              🔄 재대결 시작 (새 대기실 생성)
                            </button>
                          ) : (
                            <div style={{ padding: '0.82rem', background: 'var(--bg-page)', borderRadius: '12px', border: '1px dashed var(--border-color)', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                              ⌛ 방장이 재대결을 신청하면 자동으로 새 방으로 이동합니다.
                            </div>
                          )}
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '0.8rem 2.5rem', fontSize: '1rem', borderRadius: '12px', width: '100%', fontWeight: 'bold' }} 
                            onClick={handleLeaveRoom}
                          >
                            🚪 게임 종료하고 방 나가기
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* 작전 현황 상태 정보 바 (상단 요약 리본) */}
            <div className="status-bar" style={{ marginBottom: '1.5rem' }}>
              <div>내 역할: <span style={{ color: playerView.viewer === 'FUGITIVE' ? 'var(--danger)' : 'var(--primary)', fontWeight: 'bold' }}>{playerView.viewer === 'FUGITIVE' ? '👤 도망자' : '👮 수사관'}</span></div>
              
              {/* 차례 신호기 */}
              <div className={`turn-indicator ${playerView.viewer === playerView.currentTurn ? 'active' : 'inactive'}`} style={{ fontWeight: 'bold' }}>
                {playerView.viewer === playerView.currentTurn ? '⚡ 내 차례입니다.' : `⌛ 상대방의 차례입니다. (${playerView.currentTurn === 'FUGITIVE' ? '도망자' : '수사관'} 진행 중)`}
              </div>

              <div>상대 손패: <span style={{ fontWeight: 'bold' }}>{playerView.opponentHandSize}장</span></div>
              
              {/* 타이머 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                ⏱️ 게임 시간: <span style={{ fontWeight: 'bold' }}>{formatGameTime(gameSeconds)}</span>
              </div>

              <button className="btn btn-accent" style={{ padding: '0.35rem 0.8rem', fontSize: '0.75rem', borderRadius: '8px' }} onClick={handleForfeitGame}>
                기권하기
              </button>
            </div>

            <div className="grid-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.5rem' }}>
              {/* 왼쪽 패널: 맵 보드판 & 나의 상태 판 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* 메인 보드판 */}
                <div className="board-game-map">
                  <h3 style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                    <span>🗺️ 도망자 은신처 보드</span>
                    {playerView.viewer === 'MARSHAL' && playerView.phase !== 'MANHUNT' && (
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', fontWeight: 'normal' }}>
                        * 은신처 카드를 선택하고 숫자를 맞춰보세요.
                      </span>
                    )}
                  </h3>

                  {/* Horizontal scrolling path */}
                  <div className="board-game-path">
                    {(() => {
                      const lastRevIdx = playerView.board.reduce((lastIdx, h, idx) => h.revealed ? idx : lastIdx, 0);
                      
                      return playerView.board.map((hideout, index) => {
                        const isSelected = guessTargetIndex === index;
                        const isRevealed = hideout.revealed;
                        const isFaceUp = isRevealed || playerView.viewer === 'FUGITIVE';
                        const isHighlighted = index === hoveredLogIndex;
                        
                        const canSeeSprintCards = (isRevealed && (hideout.number !== 42 || playerView.phase === 'ENDED')) || playerView.viewer === 'FUGITIVE';
                        const sprintCount = hideout.sprintCount || (hideout.sprintCards ? hideout.sprintCards.length : 0);

                        const isFugitivePawnHere = index === playerView.board.length - 1;
                        const isMarshalPawnHere = guessTargetIndex !== null 
                          ? (index === guessTargetIndex) 
                          : (index === lastRevIdx);

                        const posCard = getPositionForCard(index);

                        return (
                          <Fragment key={index}>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '85px', position: 'relative', gridRow: posCard.row, gridColumn: posCard.col }}>
                              
                              {/* Modern Chip Pawns */}
                              {isFugitivePawnHere && (
                                <div className="board-pawn fugitive" title="도망자 현재 위치" />
                              )}
                              {isMarshalPawnHere && (
                                <div className="board-pawn marshal" title="수사관 지정 타겟" />
                              )}

                              <div 
                                className={`game-card ${isFaceUp ? 'face-up' : 'face-down'} ${isFaceUp && !isRevealed ? 'private' : ''} ${isSelected ? 'selected' : ''} ${isHighlighted ? 'pulse-highlight' : ''}`}
                                style={{ width: '80px', height: '120px', position: 'relative' }}
                                onClick={() => {
                                  if (playerView.viewer === 'MARSHAL' && !isRevealed && playerView.phase !== 'MANHUNT') {
                                    if (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing) {
                                      addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 조사할 수 있습니다!' });
                                      playSynthSound('error');
                                      return;
                                    }
                                    playSynthSound('click');
                                    setGuessTargetIndex(index);
                                    setSingleGuessValue('');
                                  }
                                }}
                              >
                                {/* 카드 숫자 공개 */}
                                {isFaceUp && hideout.number !== undefined ? (
                                  <>
                                    <span className="card-num">{hideout.number}</span>
                                    <span className="card-footprints">
                                      {Array.from({ length: getSprintValue(hideout.number) }).map((_, i) => (
                                        <span key={i}>👣</span>
                                      ))}
                                    </span>
                                    {/* 도망자만 볼 수 있는 비공개 락 아이콘 */}
                                    {playerView.viewer === 'FUGITIVE' && !isRevealed && (
                                      <span 
                                        style={{ position: 'absolute', top: '4px', right: '6px', fontSize: '0.65rem', zIndex: 10 }} 
                                        title="수사관에게 비공개 상태"
                                      >
                                        🔒
                                      </span>
                                    )}
                                  </>
                                ) : null}
                              </div>

                              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: 'bold' }}>
                                {index === 0 ? '시작점' : `은신처 ${index}`}
                              </span>

                              {/* 스프린트 정보 (비공개시 점으로 표시, 공개시 미니어처 카드로 표시) */}
                              {((hideout.sprintCards && hideout.sprintCards.length > 0) || sprintCount > 0) && (
                                <div className="sprint-dot-container" style={{ marginTop: '0.4rem' }}>
                                  {canSeeSprintCards && hideout.sprintCards && hideout.sprintCards.length > 0 ? (
                                    <div style={{ display: 'flex', gap: '3px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                      {[...hideout.sprintCards].sort((a, b) => a.number - b.number).map((c, i) => (
                                        <div 
                                          key={i} 
                                          style={{ 
                                            fontSize: '0.62rem', 
                                            background: 'var(--bg-card)', 
                                            border: '1px solid var(--border-color)', 
                                            borderRadius: '4px', 
                                            padding: '2px 5px', 
                                            minWidth: '18px', 
                                            textAlign: 'center', 
                                            fontWeight: 'bold',
                                            boxShadow: 'var(--shadow-sm)',
                                            color: 'var(--warning)',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center'
                                          }}
                                          title={`도약 카드 번호: ${c.number}`}
                                        >
                                          {c.number}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', gap: '3px', justifyContent: 'center' }}>
                                      {Array.from({ length: sprintCount }).map((_, i) => (
                                        <div key={i} className="sprint-dot" />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Dotted path connector line between slots */}
                            {index < playerView.board.length - 1 && (() => {
                              const posConn = getPositionForConnector(index);
                              return (
                                <div className="board-connector" style={{ gridRow: posConn.row, gridColumn: posConn.col }}>
                                  <span className="connector-dots">••</span>
                                  <span className="connector-footprints">👣</span>
                                  <span className="connector-dots">••</span>
                                </div>
                              );
                            })()}
                          </Fragment>
                        );
                      });
                    })()}

                    {/* 도망자 드래프트 예견 섀도우 카드 */}
                    {playerView.viewer === 'FUGITIVE' && playerView.currentTurn === 'FUGITIVE' && hasFinishedDrawing && (() => {
                      const posConn = getPositionForConnector(playerView.board.length - 1);
                      const posDraft = getPositionForCard(playerView.board.length);
                      return (
                        <>
                          <div className="board-connector draft" style={{ gridRow: posConn.row, gridColumn: posConn.col }}>
                            <span className="connector-dots">••</span>
                            <span className="connector-footprints">👣</span>
                            <span className="connector-dots">••</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '85px', gridRow: posDraft.row, gridColumn: posDraft.col }}>
                            <div 
                              className={`game-card draft-card ${selectedHideoutCard !== null ? 'active' : ''} ${selectedHideoutCard !== null ? (isDraftValid ? 'valid' : 'invalid') : ''}`}
                              style={{ width: '80px', height: '120px', position: 'relative' }}
                            >
                              {selectedHideoutCard !== null ? (
                                <>
                                  <span className="card-num">{selectedHideoutCard}</span>
                                  <span style={{ fontSize: '0.62rem', color: isDraftValid ? 'var(--success)' : 'var(--danger)', fontWeight: 'bold', textAlign: 'center', position: 'absolute', bottom: '8px' }}>
                                    {isDraftValid ? '배치 가능' : '이동 불가'}
                                  </span>
                                  {isDraftValid && (
                                    <div 
                                      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--primary-bg)', cursor: 'pointer', borderRadius: '4px', zIndex: 5 }}
                                      onClick={handlePlaceHideoutMove}
                                      title="은신처 배치"
                                    />
                                  )}
                                </>
                              ) : (
                                <span style={{ fontSize: '0.68rem', textAlign: 'center', margin: 'auto', padding: '4px', opacity: 0.6 }}>
                                  카드 선택
                                </span>
                              )}
                            </div>
                            
                            {selectedSprintCards.length > 0 && (
                              <div className="sprint-dot-container" style={{ marginTop: '0.4rem' }}>
                                {selectedSprintCards.map((_, i) => (
                                  <div key={i} className="sprint-dot" />
                                ))}
                                <div className="sprint-number-badge" style={{ marginTop: '2px' }}>
                                  (+{totalSprintPower}👣 추가)
                                </div>
                              </div>
                            )}

                            <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '0.5rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
                              배치할 {playerView.board.length}번째 은신처
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>

                  {/* Supply decks rendering directly on the Board Card */}
                  <div style={{ marginTop: '2.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
                    
                    <div style={{ display: 'flex', gap: '2rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                      {/* Deck 1 */}
                      <div 
                        className={`physical-deck ${playerView.deck1Count === 0 ? 'empty' : ''} ${
                          setupDealLocal 
                            ? (setupDealLocal.deck1Queue.length > 0 ? 'can-draw' : '')
                            : (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT' ? 'can-draw' : '')
                        }`} 
                        style={{ ...getDeckStyle(playerView.deck1Count), display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', cursor: 'pointer', transition: 'all 0.2s ease', position: 'relative' }}
                        onClick={() => {
                          if (setupDealLocal) {
                            handleFugitiveSetupDraw('DECK_1');
                          } else {
                            if (playerView.deck1Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT') {
                              handleDrawMove('DECK_1');
                            }
                          }
                        }}
                      >
                        <div style={{ fontSize: '1.6rem', zIndex: 5, marginBottom: '4px' }}>🗃️</div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.9rem', color: 'var(--text-primary)', zIndex: 5 }}>카드 더미 1</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', zIndex: 5, marginTop: '2px' }}>
                          {setupDealLocal ? `초기 드로우: ${setupDealLocal.deck1Queue.length}장 남음` : '4 ~ 14번 카드'}
                        </div>
                        <div className="deck-count-badge" style={{ marginTop: '8px' }}>{playerView.deck1Count}장</div>
                        {isCanDraw1 && <div className="draw-pulsing-badge">뽑기!</div>}
                      </div>

                      {/* Deck 2 */}
                      <div 
                        className={`physical-deck ${playerView.deck2Count === 0 ? 'empty' : ''} ${
                          setupDealLocal 
                            ? (setupDealLocal.deck2Queue.length > 0 ? 'can-draw' : '')
                            : (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT' ? 'can-draw' : '')
                        }`} 
                        style={{ ...getDeckStyle(playerView.deck2Count), display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', cursor: 'pointer', transition: 'all 0.2s ease', position: 'relative' }}
                        onClick={() => {
                          if (setupDealLocal) {
                            handleFugitiveSetupDraw('DECK_2');
                          } else {
                            if (playerView.deck2Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT') {
                              handleDrawMove('DECK_2');
                            }
                          }
                        }}
                      >
                        <div style={{ fontSize: '1.6rem', zIndex: 5, marginBottom: '4px' }}>🗃️</div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.9rem', color: 'var(--text-primary)', zIndex: 5 }}>카드 더미 2</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', zIndex: 5, marginTop: '2px' }}>
                          {setupDealLocal ? `초기 드로우: ${setupDealLocal.deck2Queue.length}장 남음` : '15 ~ 28번 카드'}
                        </div>
                        <div className="deck-count-badge" style={{ marginTop: '8px' }}>{playerView.deck2Count}장</div>
                        {isCanDraw2 && <div className="draw-pulsing-badge">뽑기!</div>}
                      </div>

                      {/* Deck 3 */}
                      <div 
                        className={`physical-deck ${playerView.deck3Count === 0 ? 'empty' : ''} ${
                          setupDealLocal 
                            ? '' 
                            : (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT' ? 'can-draw' : '')
                        }`} 
                        style={{ ...getDeckStyle(playerView.deck3Count), display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', cursor: setupDealLocal ? 'not-allowed' : 'pointer', transition: 'all 0.2s ease', position: 'relative' }}
                        onClick={() => {
                          if (setupDealLocal) {
                            addToast({ kind: 'warning', message: '⚠️ 초기 드로우는 덱 1과 덱 2에서만 진행할 수 있습니다.' });
                          } else {
                            if (playerView.deck3Count > 0 && playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT') {
                              handleDrawMove('DECK_3');
                            }
                          }
                        }}
                      >
                        <div style={{ fontSize: '1.6rem', zIndex: 5, marginBottom: '4px' }}>🗃️</div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.9rem', color: 'var(--text-primary)', zIndex: 5 }}>카드 더미 3</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', zIndex: 5, marginTop: '2px' }}>
                          {setupDealLocal ? '초기 드로우 대상 아님' : '29 ~ 41번 카드'}
                        </div>
                        <div className="deck-count-badge" style={{ marginTop: '8px' }}>{playerView.deck3Count}장</div>
                        {isCanDraw3 && <div className="draw-pulsing-badge">뽑기!</div>}
                      </div>
                    </div>

                    {(setupDealLocal || (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing && playerView.phase !== 'MANHUNT')) && (
                      <div className="draw-instructions-banner">
                        {setupDealLocal ? (
                          <span style={{ color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.85rem' }}>
                            🎯 초기 손패 구성 단계: 카드 더미 1({setupDealLocal.deck1Queue.length}장)과 더미 2({setupDealLocal.deck2Queue.length}장)를 눌러 카드를 모두 뽑으세요.
                          </span>
                        ) : playerView.viewer === 'MARSHAL' && requiredDraws === 2 ? (
                          <span style={{ color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.82rem' }}>
                            🎯 수사관 첫 턴 규칙: 카드 더미에서 카드 2장을 연속으로 뽑으세요. (뽑은 카드: {marshalDrawCount}/2장)
                          </span>
                        ) : (
                          <span style={{ color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.82rem' }}>
                            하나를 선택해 카드를 한 장 가져오세요.
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 수사관 전용 최종 추격전(맨헌트) 패널 */}
                {playerView.phase === 'MANHUNT' && playerView.viewer === 'MARSHAL' && (
                  <div className="glass-panel" style={{ border: '1px solid var(--danger)', background: 'var(--danger-bg)' }}>
                    <h3 style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>🚨 최후의 추격</h3>
                    <p style={{ fontSize: '0.88rem', marginBottom: '1.2rem', color: 'var(--text-secondary)' }}>
                      도망자가 42번 카드를 배치하여 탈출을 완료하기 직전입니다! 수사관은 보드 위의 모든 비공개 은신처 숫자를 맞춰야 합니다.<br></br>단 한 번이라도 틀리면 즉시 패배합니다.
                    </p>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      {playerView.board.map((h, i) => {
                        if (h.revealed) return null;
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg-card)', padding: '0.6rem 1.2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                            <span style={{ fontWeight: 'bold', minWidth: '80px' }}>은신처 {i}</span>
                            <input 
                              type="number" 
                              placeholder="카드 번호 입력"
                              className="cyber-input" 
                              style={{ width: '140px', textAlign: 'center' }}
                              value={manhuntGuesses[i] || ''}
                              onChange={e => {
                                const val = e.target.value;
                                setManhuntGuesses(prev => ({ ...prev, [i]: val }));
                              }}
                              disabled={playerView.viewer !== playerView.currentTurn}
                            />
                            <button 
                              className="btn btn-primary"
                              style={{ padding: '0.5rem 1.2rem', borderRadius: '8px' }}
                              disabled={playerView.viewer !== playerView.currentTurn || !manhuntGuesses[i]}
                              onClick={() => handleManhuntGuessSubmit(i)}
                            >
                              수사 제출
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* 내 행동 제어 타워 */}
                {playerView.phase !== 'MANHUNT' && (
                  <div className="glass-panel" style={{ borderTop: '4px solid var(--primary)' }}>
                    {playerView.viewer === 'FUGITIVE' ? (
                      /* 도망자 컨트롤 데스크 */
                      <div>
                        <h3 style={{ marginBottom: '0.6rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                          <span>👤 내 카드</span>
                        </h3>
                        <p style={{ fontSize: '0.9rem', marginBottom: '1.2rem', color: 'var(--text-primary)' }}>
                          마지막 은신처 번호: <strong style={{ color: 'var(--primary)', fontSize: '1.15rem' }}>{getLastHideoutNumber()}</strong>
                        </p>

                        {/* Overlapping wooden rack cards */}
                        <div className="card-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.8rem', padding: '1rem', background: 'var(--bg-page)', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                          {(setupDealLocal 
                            ? [...playerView.hand].filter(c => 
                                setupDealLocal.fixed.includes(c.number) || 
                                setupDealLocal.deck1Drawn.includes(c.number) || 
                                setupDealLocal.deck2Drawn.includes(c.number)
                              )
                            : [...playerView.hand]
                          ).sort((a, b) => a.number - b.number).map(card => {
                            const isTarget = selectedHideoutCard === card.number;
                            const isSprint = selectedSprintCards.includes(card.number);
                            
                            return (
                              <div 
                                key={card.number} 
                                className={`game-card face-up ${isTarget ? 'target-selected' : ''} ${isSprint ? 'sprint-selected' : ''}`}
                                style={{ height: '110px', padding: '0.5rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
                              >
                                <span className="card-num" style={{ fontSize: '1.3rem' }}>{card.number}</span>
                                <span className="card-footprints">
                                  {card.sprintValue > 0 && Array.from({ length: card.sprintValue }).map((_, idx) => (
                                     <span key={idx}>👣</span>
                                  ))}
                                </span>

                                {/* Card hover rack action menu */}
                                <div className="card-action-menu">
                                  <div 
                                    className="card-action-btn accent"
                                    onClick={() => {
                                      if (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing) {
                                        addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 은신처를 배치할 수 있습니다!' });
                                        playSynthSound('error');
                                        return;
                                      }
                                      playSynthSound('click');
                                      if (isSprint) {
                                        setSelectedSprintCards(prev => prev.filter(c => c !== card.number));
                                      }
                                      setSelectedHideoutCard(isTarget ? null : card.number);
                                    }}
                                  >
                                    {isTarget ? '지정 취소' : '은신처 지정'}
                                  </div>
                                  <div 
                                    className={`card-action-btn ${card.number === 42 ? 'disabled' : ''}`}
                                    style={card.number === 42 ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                                    onClick={() => {
                                      if (playerView.viewer === playerView.currentTurn && !hasFinishedDrawing) {
                                        addToast({ kind: 'error', title: '행동 불가', message: '카드를 먼저 뽑은 후에 은신처를 배치할 수 있습니다!' });
                                        playSynthSound('error');
                                        return;
                                      }
                                      if (card.number === 42) {
                                        playSynthSound('error');
                                        addToast('⚠️ 42번 카드는 최종 탈출 목적지 전용 카드입니다. 도약 발자국 카드로 소모할 수 없습니다.');
                                        return;
                                      }
                                      playSynthSound('click');
                                      if (isTarget) {
                                        setSelectedHideoutCard(null);
                                      }
                                      if (isSprint) {
                                        setSelectedSprintCards(prev => prev.filter(c => c !== card.number));
                                      } else {
                                        setSelectedSprintCards(prev => [...prev, card.number]);
                                      }
                                    }}
                                  >
                                    {isSprint ? '도약 취소' : '도약 👣'}
                                  </div>
                                </div>

                                {isTarget && <span className="card-badge target">은신처</span>}
                                {isSprint && <span className="card-badge sprint">+{card.sprintValue}👣</span>}
                              </div>
                            );
                          })}
                        </div>

                        {/* Real-time flight vector calculator */}
                        {selectedHideoutCard !== null && (
                          <div className="glass-panel" style={{ background: 'var(--bg-page)', border: '1px solid var(--border-color)', margin: '1.2rem 0', padding: '1.2rem', borderRadius: '12px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                              {/* Title / Status Pill */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.6rem', marginBottom: '0.2rem' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '0.92rem' }}>📋 이동 분석 결과</span>
                                <span style={{ 
                                  padding: '0.25rem 0.8rem', 
                                  borderRadius: '20px', 
                                  fontSize: '0.78rem', 
                                  fontWeight: 'bold',
                                  backgroundColor: isSprintPowerSufficient ? 'var(--success-bg)' : 'var(--danger-bg)',
                                  color: isSprintPowerSufficient ? 'var(--success)' : 'var(--danger)',
                                  border: isSprintPowerSufficient ? '1px solid var(--success)' : '1px dashed var(--danger)'
                                }}>
                                  {isSprintPowerSufficient ? '✓ 이동 가능' : '✗ 발자국 부족'}
                                </span>
                              </div>

                              {/* Row 1: 이동 경로 & 이동 거리 */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>이동 경로</span>
                                <span style={{ fontWeight: 'bold' }}>{getLastHideoutNumber()} ➡️ {selectedHideoutCard}</span>
                              </div>

                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>이동 거리</span>
                                <span style={{ fontWeight: 'bold' }}>{movementDistance}칸</span>
                              </div>

                              {/* Row 2: 필요한 발자국 & 제출한 발자국 */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>필요한 발자국 (기본 3칸 초과분)</span>
                                <span style={{ fontWeight: 'bold' }}>{footprintsRequired}👣</span>
                              </div>

                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>사용 중인 도약 카드</span>
                                <span style={{ fontWeight: 'bold', color: isSprintPowerSufficient ? 'var(--success)' : 'var(--danger)' }}>
                                  {totalSprintPower}👣
                                </span>
                              </div>
                            </div>

                            {selectedHideoutCard <= getLastHideoutNumber() && (
                              <div style={{ color: 'var(--text-primary)', marginTop: '0.8rem', fontSize: '0.8rem', fontWeight: 600, textAlign: 'center', background: 'var(--danger-bg)', padding: '0.5rem', borderRadius: '8px' }}>
                                ⚠️ 새 은신처는 직전 은신처({getLastHideoutNumber()})보다 높은 번호의 카드여야 합니다.
                              </div>
                            )}
                          </div>
                        )}

                        {/* Fugitive Action Buttons */}
                        <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                          <button 
                            className="btn btn-secondary"
                            style={{ borderRadius: '8px' }}
                            onClick={handlePassMove}
                            disabled={playerView.viewer !== playerView.currentTurn || playerView.board.length === 1 || !hasFinishedDrawing}
                            title={playerView.board.length === 1 ? "첫 번째 턴에는 무조건 은신처를 하나 이상 배치해야 합니다." : ""}
                          >
                            차례 넘기기
                          </button>
                          <button 
                            className="btn btn-primary"
                            style={{ borderRadius: '8px' }}
                            onClick={handlePlaceHideoutMove}
                            disabled={
                              playerView.viewer !== playerView.currentTurn ||
                              selectedHideoutCard === null ||
                              selectedHideoutCard <= getLastHideoutNumber() ||
                              !isSprintPowerSufficient ||
                              !hasFinishedDrawing
                            }
                          >
                            은신처 배치 완료
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 수사관 컨트롤 데스크 */
                      <div>
                        <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>👮 수사관 추리판</h3>
                        
                        {playerView.hand && playerView.hand.length > 0 && (
                          <div style={{ marginBottom: '1.5rem' }}>
                            <span className="cyber-label">🔍 제외된 카드 목록</span>
                            <div className="card-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', padding: '0.8rem', background: 'var(--bg-page)', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
                              {[...playerView.hand].sort((a, b) => a.number - b.number).map(card => (
                                <div key={card.number} className="game-card face-up disabled" style={{ height: '70px', width: '48px', padding: '0.3rem', justifyContent: 'center' }}>
                                  <span className="card-num" style={{ fontSize: '1.1rem', margin: 'auto' }}>{card.number}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Marshal Search Coordinates input */}

                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                          {guessTargetIndex !== null ? (
                            <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.8rem', background: 'var(--bg-page)', padding: '0.8rem 1.2rem', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
                              <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>은신처 {guessTargetIndex}번 칸 정답:</span>
                              <input 
                                type="number"
                                className="cyber-input"
                                style={{ width: '90px', textAlign: 'center', padding: '0.4rem', borderRadius: '8px' }}
                                value={singleGuessValue}
                                onChange={e => setSingleGuessValue(e.target.value)}
                                placeholder="추측 번호"
                                disabled={playerView.viewer !== playerView.currentTurn}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleGuessMove();
                                }}
                              />
                              <button 
                                className="btn btn-primary" 
                                style={{ padding: '0.5rem 1.2rem', fontSize: '0.82rem', borderRadius: '8px' }}
                                disabled={playerView.viewer !== playerView.currentTurn || !singleGuessValue.trim()}
                                onClick={handleGuessMove}
                              >
                                수사 제출
                              </button>
                              <button className="btn btn-secondary" style={{ padding: '0.5rem 0.8rem', fontSize: '0.82rem', borderRadius: '8px' }} onClick={() => setGuessTargetIndex(null)}>
                                취소
                              </button>
                            </div>
                          ) : (
                            <div style={{ color: 'var(--text-tertiary)', fontStyle: 'italic', fontSize: '0.88rem' }}>
                              💡 일괄 수색: 한 번의 기회로 여러 은신처를 수색할 수 있습니다.
                            </div>
                          )}
                        </div>

                        {/* 수사관 일괄 수색 버튼 */}
                        <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                          <button 
                            className="btn btn-secondary"
                            style={{ borderRadius: '8px' }}
                            onClick={() => {
                              playSynthSound('click');
                              const unrevealedCount = playerView.board.filter(h => !h.revealed).length;
                              setMultiGuesses(Array(unrevealedCount).fill(''));
                              setIsMultiGuessMode(true);
                            }}
                            disabled={
                              playerView.viewer !== playerView.currentTurn || 
                              playerView.board.filter(h => !h.revealed).length < 2 ||
                              !hasFinishedDrawing
                            }
                          >
                            💥 일괄 수색 (선택/전체 추측)
                          </button>
                        </div>

                        {/* 일괄 수색 모달 */}
                        {isMultiGuessMode && (
                          <div className="modal-backdrop" onClick={() => setIsMultiGuessMode(false)}>
                            <div className="modal-content" style={{ maxWidth: '440px', width: '90%', padding: '2rem', borderRadius: '20px' }} onClick={e => e.stopPropagation()}>
                              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '1.25rem', color: 'var(--primary)' }}>
                                🔍 은신처 일괄 수색
                              </h3>
                              <p style={{ fontSize: '0.82rem', marginBottom: '1.5rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                                추측하고자 하는 비공개 은신처 번호만 골라서 입력할 수 있습니다. 입력하지 않은 빈칸은 수색에서 제외되며, <strong style={{ color: 'var(--danger)' }}>입력한 칸 중 단 하나라도 틀리면 수색 전체가 실패</strong>하고 아무 정보도 공개되지 않습니다.
                              </p>

                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', maxHeight: '280px', overflowY: 'auto', paddingRight: '0.5rem', paddingLeft: '0.1rem' }}>
                                {playerView.board.map((h, i) => {
                                  if (h.revealed) return null;
                                  const unrevealed = playerView.board.map((hd, idx) => ({ hd, idx })).filter(item => !item.hd.revealed);
                                  const localIdx = unrevealed.findIndex(item => item.idx === i);

                                  return (
                                    <div 
                                      key={i} 
                                      style={{ 
                                        display: 'flex', 
                                        alignItems: 'center', 
                                        justifyContent: 'space-between', 
                                        padding: '0.6rem 0', 
                                        borderBottom: '1px solid var(--border-color)' 
                                      }}
                                    >
                                      <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                        은신처 {i}
                                      </span>
                                      <input 
                                        type="number"
                                        placeholder="추측 번호"
                                        className="cyber-input"
                                        style={{ 
                                          width: '120px', 
                                          textAlign: 'center', 
                                          borderRadius: '8px', 
                                          padding: '0.4rem', 
                                          fontSize: '0.85rem',
                                          background: 'var(--bg-page)',
                                          border: '1px solid var(--border-color)',
                                          color: 'var(--text-primary)'
                                        }}
                                        value={multiGuesses[localIdx] || ''}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setMultiGuesses(prev => {
                                            const next = [...prev];
                                            next[localIdx] = val;
                                            return next;
                                          });
                                        }}
                                      />
                                    </div>
                                  );
                                })}
                              </div>

                              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.8rem' }}>
                                <button className="btn btn-primary" style={{ flex: 1, borderRadius: '10px', padding: '0.75rem' }} onClick={handleMultiGuessMove}>
                                  ⚡ 수색 시작
                                </button>
                                <button className="btn btn-secondary" style={{ flex: 1, borderRadius: '10px', padding: '0.75rem' }} onClick={() => setIsMultiGuessMode(false)}>
                                  취소
                                </button>
                              </div>\
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 오른쪽 패널: 실시간 수사 일지 로그, 수사 판 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* 수사 체크리스트 */}
                <div className="detective-notepad">
                  <h4 style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.8rem' }}>
                    <span>📋 카드 현황판</span>
                  </h4>
                  
                  <div className="notepad-grid">
                    {Array.from({ length: 43 }, (_, i) => {
                      const isRevealedHideout = playerView.board.some(h => h.revealed && h.number === i);
                      const isPrivateHideout = playerView.viewer === 'FUGITIVE' && playerView.board.some(h => !h.revealed && h.number === i);
                      const isHandCard = playerView.hand && playerView.hand.some(c => c.number === i);
                      const isSprintCard = playerView.viewer === 'FUGITIVE'
                        ? playerView.board.some(h => h.sprintCards?.some(c => c.number === i))
                        : playerView.board.some(h => h.revealed && h.sprintCards?.some(c => c.number === i));

                      let cellClass = '';
                      let cellTitle = `미공개 상태 (${i}번)`;

                      if (isRevealedHideout) {
                        cellClass = 'revealed';
                        cellTitle = `공개된 은신처 (${i}번)`;
                      } else if (isPrivateHideout) {
                        cellClass = 'private-hideout';
                        cellTitle = `내 비공개 은신처 (${i}번)`;
                      } else if (isHandCard) {
                        cellClass = 'hand';
                        cellTitle = `내 손패 (${i}번)`;
                      } else if (isSprintCard) {
                        cellClass = 'sprint';
                        cellTitle = playerView.viewer === 'FUGITIVE'
                          ? `도약 카드로 사용한 카드 (${i}번)`
                          : `도약 카드로 사용된 카드 (공개됨, ${i}번)`;
                      } else {
                        const note = notepadNotes[i] || 'none';
                        if (note === 'strikethrough') {
                          cellClass = 'strikethrough';
                          cellTitle = `수색 제외 (${i}번)`;
                        } else if (note === 'suspect') {
                          cellClass = 'suspect';
                          cellTitle = `용의 카드 (${i}번)`;
                        }
                      }

                      const hasAutoState = isRevealedHideout || isPrivateHideout || isHandCard || isSprintCard;
                      const canClick = !hasAutoState;

                      return (
                        <div 
                          key={i} 
                          className={`notepad-cell ${cellClass}`}
                          style={{ cursor: canClick ? 'pointer' : 'default' }}
                          title={cellTitle}
                          onClick={() => {
                            if (canClick) {
                              playSynthSound('click');
                              setNotepadNotes(prev => {
                                const current = prev[i] || 'none';
                                let next: 'none' | 'strikethrough' | 'suspect' = 'none';
                                if (playerView.viewer === 'FUGITIVE') {
                                  next = current === 'none' ? 'strikethrough' : 'none';
                                } else {
                                  if (current === 'none') next = 'strikethrough';
                                  else if (current === 'strikethrough') next = 'suspect';
                                }
                                return { ...prev, [i]: next };
                              });
                            }
                          }}
                        >
                          {i}
                        </div>
                      );
                    })}
                  </div>

                  {/* 범례 (Legend) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '1rem', fontSize: '0.72rem', alignItems: 'center' }}>
                    {/* 첫 번째 줄: 게임 자동 마킹 상태 */}
                    <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--primary)' }} />
                        <span>공개 은신처</span>
                      </div>
                      {playerView.viewer === 'FUGITIVE' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '2px solid var(--primary)', backgroundColor: 'var(--primary-bg)' }} />
                          <span>비공개 은신처</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--success)' }} />
                        <span>내 손패</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--warning)' }} />
                        <span>도약 카드</span>
                      </div>
                    </div>
                    
                    {/* 두 번째 줄: 수동 마킹 상태 */}
                    {(playerView.viewer === 'MARSHAL' || playerView.viewer === 'FUGITIVE') && (
                      <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-page)', textDecoration: 'line-through', fontSize: '8px', lineHeight: '10px', textAlign: 'center', color: 'var(--text-tertiary)' }} />
                          <span>제외 (클릭)</span>
                        </div>
                        {playerView.viewer === 'MARSHAL' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '1px solid var(--danger)', backgroundColor: 'var(--danger-bg)' }} />
                            <span>용의 (클릭)</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                </div>

                {/* 실시간 피드 - Spiral notebook ledger style */}
                <div className="notepad-log">
                  <h4 style={{ marginBottom: '0.8rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                    📓 게임 로그
                  </h4>
                  <div className="log-panel" ref={logPanelRef}>
                    {actionLog.map((log, index) => {
                      let logClass = 'log-entry-info';
                      if (log.startsWith('👤') || log.startsWith('👣')) logClass = 'FUGITIVE';
                      if (
                        log.startsWith('👮') || 
                        log.startsWith('🎯') || 
                        log.startsWith('❌') || 
                        log.startsWith('🚨') ||
                        log.startsWith('💨') ||
                        log.startsWith('✈️')
                      ) logClass = 'MARSHAL';
                      
                      // 마우스 호버 시 보드 카드 피드백
                      let targetIdx: number | null = null;
                      if (log.includes('은신처') || log.includes('Slot')) {
                        const match = log.match(/(?:은신처\s*#?|Slot\s*#?)(\d+)(?!\s*곳)/) || log.match(/(\d+)(?:번째\s*)은신처/);
                        if (match) {
                          targetIdx = parseInt(match[1], 10);
                        }
                      }

                      return (
                        <div 
                          key={index} 
                          className={`log-entry ${logClass}`}
                          style={{ cursor: targetIdx !== null ? 'pointer' : 'default' }}
                          onMouseEnter={() => targetIdx !== null && setHoveredLogIndex(targetIdx)}
                          onMouseLeave={() => setHoveredLogIndex(null)}
                        >
                          {log}
                        </div>
                      );
                    })}
                  </div>
                </div>


              </div>
            </div>
          </div>
        )}


      {drawnCardEffect && drawnCardEffect.visible && (
        <div 
          className="draw-effect-overlay" 
          onClick={() => setDrawnCardEffect(prev => prev ? { ...prev, visible: false } : null)}
        >
          <div className="draw-effect-container">
            <h2 className={`draw-effect-title ${drawnCardEffect.role.toLowerCase()}`}>
              {drawnCardEffect.role === 'FUGITIVE' ? '카드 획득!' : '카드 획득!'}
            </h2>
            <div className={`draw-effect-card ${drawnCardEffect.role.toLowerCase()}`}>
              <div className="draw-effect-badge">CARD</div>
              <div className="draw-effect-number">{drawnCardEffect.number}</div>
              <div className="draw-effect-footprints">
                {Array.from({ length: drawnCardEffect.sprintValue }).map((_, idx) => (
                  <span key={idx}>👣</span>
                ))}
                <span style={{ fontSize: '0.85rem', marginLeft: '4px' }}>+{drawnCardEffect.sprintValue}</span>
              </div>
            </div>
            <div className="draw-effect-hint">화면을 클릭하면 바로 닫힙니다</div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}


export default App;
