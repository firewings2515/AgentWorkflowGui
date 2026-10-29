import type { McpElicitation } from '../../../contracts';

type Json = NonNullable<Extract<McpElicitation, { mode: 'form' }>['requestedSchema']> | null;
const object = (value: Json | undefined): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Schemas are data, never executable HTML. Complex schemas remain editable as JSON. */
export function ElicitationFields({ elicitation, value, onChange }: {
  elicitation: Extract<McpElicitation, { mode: 'form' }>; value: string; onChange: (value: string) => void;
}) {
  const schema = elicitation.requestedSchema;
  const properties = object(schema) && object(schema.properties) ? schema.properties : undefined;
  const simple = object(schema) && schema.type === 'object' && properties && Object.values(properties).every(field =>
    object(field) && typeof field.type === 'string' && ['string', 'number', 'integer', 'boolean'].includes(field.type));
  let answers: Record<string, Json> = {};
  try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = parsed as Record<string, Json>; } catch { /* JSON editor shows validation at submission. */ }
  const change = (name: string, answer: Json | undefined) => {
    const next = { ...answers };
    if (answer === undefined) delete next[name]; else next[name] = answer;
    onChange(JSON.stringify(next));
  };
  return <div className="elicitation-fields">
    <p>{elicitation.serverName}：{elicitation.message}</p>
    <details><summary>檢視請求的表單結構</summary><pre>{JSON.stringify(schema, null, 2)}</pre></details>
    {simple ? Object.entries(properties).map(([name, field]) => {
      if (!object(field)) return null;
      const required = Array.isArray(schema.required) && schema.required.includes(name);
      const label = typeof field.title === 'string' ? field.title : name;
      const values = Array.isArray(field.enum) ? field.enum : undefined;
      return <label key={name}>{label}{required ? '（必填）' : ''}
        {typeof field.description === 'string' && <span className="muted">{field.description}</span>}
        {field.type === 'boolean' || values ? <select required={required} value={answers[name] === undefined ? '' : JSON.stringify(answers[name])} onChange={event => change(name, event.target.value ? JSON.parse(event.target.value) as Json : undefined)}>
          <option value="">尚未填寫</option>{(values ?? [true, false]).map(option => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{typeof option === 'boolean' ? option ? '是' : '否' : typeof option === 'string' ? option : JSON.stringify(option)}</option>)}
        </select> : <input required={required} type={field.type === 'string' ? 'text' : 'number'}
          step={field.type === 'integer' ? 1 : 'any'} min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined}
          minLength={typeof field.minLength === 'number' ? field.minLength : undefined} maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}
          value={typeof answers[name] === 'string' || typeof answers[name] === 'number' ? String(answers[name]) : ''}
          onChange={event => change(name, field.type === 'string' ? event.target.value : event.target.value === '' ? undefined : Number(event.target.value))} />}
      </label>;
    }) : <label>表單內容（JSON）<textarea rows={5} value={value} onChange={event => onChange(event.target.value)} /><span className="muted">依上方表單結構填入內容；服務會驗證回覆。</span></label>}
  </div>;
}
