import { useEffect, useMemo, useState } from 'react';
import {
  LIBRARY_CATEGORIES,
  filterCatalog,
  loadPolyhavenCatalog,
  type LibraryCategory,
  type LibraryEntry,
} from '../library/catalog.ts';

interface LibraryPanelProps {
  busyId: string | null;
  onImport: (entry: LibraryEntry) => void;
  onClose: () => void;
}

function Thumb({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="ph">{name.slice(0, 1)}</div>;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function LibraryPanel({ busyId, onImport, onClose }: LibraryPanelProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<LibraryCategory>('furniture');
  const [assets, setAssets] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    loadPolyhavenCatalog()
      .then((list) => {
        if (!cancel) setAssets(list);
      })
      .catch(() => {
        if (!cancel) setError('가구 목록을 불러오지 못했습니다. 사람 모델은 그대로 사용할 수 있습니다.');
      });
    return () => {
      cancel = true;
    };
  }, []);

  const items = useMemo(() => filterCatalog(assets ?? [], category, query), [assets, category, query]);

  return (
    <aside className="library" aria-label="라이브러리">
      <header className="library-head">
        <strong>라이브러리</strong>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </header>
      <input
        className="library-search"
        type="search"
        placeholder="이름 검색"
        value={query}
        aria-label="라이브러리 검색"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="library-cats">
        {LIBRARY_CATEGORIES.map((item) => (
          <button key={item.id} type="button" className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="library-note">
        가구나 소품은 Poly Haven(CC0), 서 있는 사람은 Khronos 샘플(CC BY)입니다. 누르면 지금 보는 위치의 바닥에 놓입니다.
      </p>
      <div className="library-grid">
        {error && category !== 'people' && <p className="library-empty">{error}</p>}
        {!assets && !error && category !== 'people' && <p className="library-empty">목록을 불러오는 중</p>}
        {assets && items.length === 0 && <p className="library-empty">해당하는 모델이 없습니다.</p>}
        {items.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={busyId === entry.id ? 'library-card busy' : 'library-card'}
            disabled={busyId !== null}
            title={`${entry.credit}${entry.polycount ? ` · 면 약 ${entry.polycount.toLocaleString('ko-KR')}` : ''}`}
            onClick={() => onImport(entry)}
          >
            <Thumb src={entry.thumb} name={entry.name} />
            <span>{busyId === entry.id ? '가져오는 중' : entry.name}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
