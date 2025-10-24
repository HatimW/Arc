export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'];
export const RETIRE_RATING = 'retire';

// Stored as minutes to keep persistence compact. Additional fields control the
// behaviour of the scheduler and provide sane defaults for the "Anki-like"
// workflow requested in the UI.
export const DEFAULT_REVIEW_STEPS = {
  again: 10,
  hard: 60,
  good: 720,
  easy: 2160,
  learningSteps: [10, 60],
  relearningSteps: [10],
  graduatingGood: 1440,
  graduatingEasy: 2880,
  startingEase: 2.5,
  minimumEase: 1.3,
  easeBonus: 0.15,
  easePenalty: 0.2,
  hardEasePenalty: 0.05,
  hardIntervalMultiplier: 1.2,
  easyIntervalBonus: 1.5,
  intervalModifier: 1,
  lapseIntervalMultiplier: 0.5
};
