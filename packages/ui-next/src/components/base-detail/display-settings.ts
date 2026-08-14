export type BaseDetailDisplaySettings = {
  showProblemCount: boolean;
  showNodeNumber: boolean;
  showNodeCardTimestamps: boolean;
  showProblemTree: boolean;
  showProblemTags: boolean;
  showCardTags: boolean;
  showAiTutor: boolean;
  showExpandSaveIndicator: boolean;
  showWsIndicator: boolean;
  showToolbar: boolean;
  indicatorX: number;
  indicatorY: number;
  toolbarOpen: boolean;
  toolbarX: number;
  toolbarY: number;
  cardDrawerWidth: number;
  treeDrawerWidth: number;
  wsIndicatorX: number;
  wsIndicatorY: number;
  wsIndicatorOpen: boolean;
};

export const defaultBaseDetailDisplaySettings = (): BaseDetailDisplaySettings => ({
  showProblemCount: false,
  showNodeNumber: false,
  showNodeCardTimestamps: false,
  showProblemTree: false,
  showProblemTags: false,
  showCardTags: false,
  showAiTutor: true,
  showExpandSaveIndicator: true,
  showWsIndicator: true,
  showToolbar: true,
  indicatorX: 320,
  indicatorY: 72,
  toolbarOpen: false,
  toolbarX: 320,
  toolbarY: 108,
  cardDrawerWidth: 420,
  treeDrawerWidth: 320,
  wsIndicatorX: 40,
  wsIndicatorY: 40,
  wsIndicatorOpen: true,
});

export function readBaseDetailDisplaySettings(raw: unknown): BaseDetailDisplaySettings {
  const defaults = defaultBaseDetailDisplaySettings();
  if (!raw || typeof raw !== 'object') return defaults;
  const values = raw as Record<string, unknown>;
  return {
    ...defaults,
    showProblemCount: values.showProblemCount === true,
    showNodeNumber: values.showNodeNumber === true,
    showNodeCardTimestamps: values.showNodeCardTimestamps === true,
    showProblemTree: values.showProblemTree === true,
    showProblemTags: values.showProblemTags === true,
    showCardTags: values.showCardTags === true,
    showAiTutor: values.showAiTutor !== false,
    showExpandSaveIndicator: values.showExpandSaveIndicator !== false,
    showWsIndicator: values.showWsIndicator !== false,
    showToolbar: values.showToolbar !== false,
    indicatorX: typeof values.indicatorX === 'number' ? values.indicatorX : defaults.indicatorX,
    indicatorY: typeof values.indicatorY === 'number' ? values.indicatorY : defaults.indicatorY,
    toolbarOpen: values.toolbarOpen === true,
    toolbarX: typeof values.toolbarX === 'number' ? values.toolbarX : defaults.toolbarX,
    toolbarY: typeof values.toolbarY === 'number' ? values.toolbarY : defaults.toolbarY,
    cardDrawerWidth: typeof values.cardDrawerWidth === 'number' ? values.cardDrawerWidth : defaults.cardDrawerWidth,
    treeDrawerWidth: typeof values.treeDrawerWidth === 'number' ? values.treeDrawerWidth : defaults.treeDrawerWidth,
    wsIndicatorX: typeof values.wsIndicatorX === 'number' ? values.wsIndicatorX : defaults.wsIndicatorX,
    wsIndicatorY: typeof values.wsIndicatorY === 'number' ? values.wsIndicatorY : defaults.wsIndicatorY,
    wsIndicatorOpen: values.wsIndicatorOpen !== false,
  };
}
