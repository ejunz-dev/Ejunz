import type { Problem } from 'ejun/src/interface';

/** Card as the lesson snapshot delivers it (full doc, problems already filtered). */
export interface LessonCard {
  docId: string;
  title?: string;
  content?: string;
  cardFace?: string;
  cardType?: string;
  nodeId?: string;
  tags?: string[];
  problems?: Problem[];
}

export interface LessonNode {
  id: string;
  title?: string;
  text?: string;
}

/** One queued card of the session (server keeps the cursor). */
export interface LessonFlatCard {
  nodeId?: string;
  cardId: string;
  nodeTitle?: string;
  cardTitle?: string;
}

/**
 * Lesson payload for the current card: page args on first paint and again on
 * every `spaNext` response from `/learn/lesson/pass`.
 */
export interface LessonSnapshot {
  card: LessonCard;
  node?: LessonNode;
  cards?: LessonCard[];
  currentIndex?: number;
  domainId?: string;
  baseDocId?: string;
  isAlonePractice?: boolean;
  isSingleNodeMode?: boolean;
  isTodayMode?: boolean;
  isAllDomainsMode?: boolean;
  hasProblems?: boolean;
  flatCards?: LessonFlatCard[];
  currentCardIndex?: number;
  rootNodeId?: string;
  rootNodeTitle?: string;
  lessonSourceUrl?: string;
  lessonFilterSummary?: string;
  lessonReviewCardIds?: string[];
  lessonCardTimesMs?: number[];
  reviewCardId?: string;
  lessonSessionId?: string;
  lessonSessionDomainId?: string;
  learnRecordId?: string;
  lessonCardProvenanceLabel?: string;
  lessonLearnSessionMode?: string;
  lessonTodayModesConfigLine?: string;
  lessonTodayCardKindLabel?: string;
  lessonSessionQueueNewOldLabel?: string;
}

/** One answered problem, exactly as `POST /learn/lesson/pass` expects it. */
export interface LessonAnswerRecord {
  problemId: string;
  cardId: string;
  selected: number;
  correct: boolean;
  timeSpent: number;
  attempts: number;
  fillAnswers?: string[];
}

export interface LessonPassResponse {
  success?: boolean;
  spaNext?: boolean | string;
  lesson?: LessonSnapshot;
  redirect?: string;
}
