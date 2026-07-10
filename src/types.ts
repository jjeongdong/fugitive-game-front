export type Role = 'FUGITIVE' | 'MARSHAL';
export type RoomStatus = 'WAITING' | 'STARTED' | 'CLOSED';
export type Phase = 'IN_PROGRESS' | 'MANHUNT' | 'ENDED';
export type Deck = 'DECK_1' | 'DECK_2' | 'DECK_3';

export interface Card {
  number: number;
  sprintValue: number;
}

export interface HideoutView {
  number?: number; // 생략 가능 (보안관 시점 비공개 은신처)
  sprintCards?: Card[]; // 생략 가능 (비공개 시)
  sprintCount: number;
  revealed: boolean;
}

export interface PlayerView {
  viewer: Role;
  board: HideoutView[];
  hand: Card[]; // 내 손패만 (보안관은 항상 [])
  opponentHandSize: number;
  deck1Count: number;
  deck2Count: number;
  deck3Count: number;
  currentTurn: Role;
  phase: Phase;
  winner?: Role | null;
}

export interface RoomState {
  roomId: string;
  hostId: string;
  guestId?: string;
  guestReady: boolean;
  hostRole?: Role;
  guestRole?: Role;
  status: RoomStatus;
  hostNickname?: string;
  guestNickname?: string;
  hostName?: string;
  guestName?: string;
}

export interface GameResult {
  roomId: string;
  winnerRole: Role;
  winnerPlayerId: string;
  fugitivePlayerId: string;
  marshalPlayerId: string;
  endedAt: string;
  fugitiveNickname?: string;
  marshalNickname?: string;
  fugitiveName?: string;
  marshalName?: string;
}

export interface RoleStats {
  games: number;
  wins: number;
  losses: number;
}

export interface PlayerStats {
  playerId: string;
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  asFugitive: RoleStats;
  asMarshal: RoleStats;
}

export interface ErrorResponse {
  code: string;
  reason: string;
  message: string;
}

export interface MoveRequest {
  type: 'DRAW_CARD' | 'PLACE_HIDEOUT' | 'PASS' | 'GUESS' | 'MANHUNT_GUESS';
  deck?: Deck;
  hideout?: number;
  sprintCards?: number[];
  targets?: Array<{ position: number; number: number }>;
  target?: { position: number; number: number };
}
