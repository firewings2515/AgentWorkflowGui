/** Shared explanation for controls that write application data. */
export const readOnlyProps = (readOnly: boolean) => readOnly ? {
  'aria-describedby': 'read-only-reason',
  title: '唯讀模式：寫入操作已停用；可閱讀資料及安排還原。',
} : {};
