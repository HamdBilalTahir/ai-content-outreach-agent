import { cn } from '@/lib/utils';
import {
  fieldEntries,
  formatLeaf,
  humanize,
  isPlainObject,
  isPrimitiveArray,
} from './helpers';

// Recursively render an object as elegant, borderless key/value rows. Nested
// objects/arrays become a small group title with their children indented under a
// subtle left guide rail (so same-named leaves under different parents stay
// distinct without box-in-box clutter). Leaves are quiet label-over-value pairs.
export function FieldTree({ data, depth = 0 }: { data: any; depth?: number }) {
  return (
    <div
      className={cn(
        'space-y-2.5',
        depth > 0 && 'ml-0.5 border-l border-gray-100 pl-3'
      )}
    >
      {fieldEntries(data).map(([k, v]) => {
        const isGroup =
          (isPlainObject(v) && Object.keys(v).length > 0) ||
          (Array.isArray(v) && !isPrimitiveArray(v) && v.length > 0);
        if (isGroup) {
          return (
            <div key={k} className="space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-600">
                {humanize(k)}
              </div>
              <FieldTree data={v} depth={depth + 1} />
            </div>
          );
        }
        return (
          <div key={k}>
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
              {humanize(k)}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-gray-700">
              {formatLeaf(v)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Readable key/value pairs instead of a JSON blob.
export function FieldList({ value }: { value: any }) {
  if (fieldEntries(value).length === 0)
    return <p className="text-[12px] text-gray-400">—</p>;
  return <FieldTree data={value} />;
}
