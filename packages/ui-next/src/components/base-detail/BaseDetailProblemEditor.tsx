import type { ComponentProps } from 'react';
import { BaseDetailProblemForm } from './BaseDetailProblemForm';

export function BaseDetailProblemEditor(props: ComponentProps<typeof BaseDetailProblemForm>) {
  return <BaseDetailProblemForm {...props} />;
}
