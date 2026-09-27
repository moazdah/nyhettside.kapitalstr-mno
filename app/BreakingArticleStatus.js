'use client';
import { useEffect,useState } from 'react';
import { useRouter } from 'next/navigation';
export default function BreakingArticleStatus({until}) {
 const router=useRouter();
 const [active,setActive]=useState(()=>new Date(until)>new Date());
 useEffect(()=>{
  function refresh() {const running=new Date(until)>new Date();setActive(running);if(!document.hidden) router.refresh();}
  if(!active) return;
  const interval=setInterval(refresh,10000);document.addEventListener('visibilitychange',refresh);
  return ()=>{clearInterval(interval);document.removeEventListener('visibilitychange',refresh);};
 },[until,active,router]);
 if(!active) return null;
 return <div className="breakingArticleStatus"><span className="breakingLabel"><span className="breakingDot" aria-hidden="true"/>SISTE</span><span>Oppdateres automatisk</span></div>;
}
