import type { Problem } from 'ejun/src/interface';

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

export interface LessonFlatCard {
  nodeId?: string;
  cardId: string;
  nodeTitle?: string;
  cardTitle?: string;
}

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
  flatQueueCards?: LessonCard[];
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
  lessonProblemTagOptions?: string[];
  lessonCanEditProblemTags?: boolean;
}

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
