import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getToken, Me, setToken } from './api';
import Login from './Login';
import Dashboard from './Dashboard';
import Items from './Items';
import ItemDetail from './ItemDetail';
import NewItem from './NewItem';

function useHash() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => { const f = () => setH(location.hash || '#/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

export default function App() {
  const hash = useHash();
  const loggedIn = !!getToken();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), enabled: loggedIn, staleTime: 60_000 });
  if (!loggedIn) return <Login />;
  if (me.isLoading) return <p className="muted pad">Loading…</p>;
  if (me.error || !me.data) return <p className="pad">Could not load your profile. <button onClick={() => { setToken(null); location.reload(); }}>Sign in again</button></p>;

  const [path, qs] = hash.slice(1).split('?');
  const params = new URLSearchParams(qs ?? '');
  const detail = path.match(/^\/items\/(\d+)$/);
  const nav = (p: string, text: string) => <a href={`#${p}`} className={path === p ? 'active' : ''}>{text}</a>;

  return (
    <>
      <header className="top">
        <strong>Operations Desk</strong>
        <nav>{nav('/', 'Dashboard')}{nav('/items', 'All items')}{nav('/new', 'New item')}</nav>
        <span className="who">
          {me.data.name} <small>{me.data.memberships.map((m) => `${m.team_name}: ${m.role}`).join(' · ')}</small>
          <button className="ghost" onClick={() => { setToken(null); location.hash = '#/'; location.reload(); }}>Sign out</button>
        </span>
      </header>
      <main>
        {detail ? <ItemDetail key={detail[1]} id={Number(detail[1])} me={me.data} />
          : path === '/items' ? <Items me={me.data} params={params} />
          : path === '/new' ? <NewItem me={me.data} />
          : <Dashboard />}
      </main>
    </>
  );
}
