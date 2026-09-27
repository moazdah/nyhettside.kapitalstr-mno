'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
export default function BreakingBanner({initialStory=null}) {
 const [story,setStory]=useState(initialStory);
 useEffect(()=>{
  let disposed=false,controller=null;
  async function refresh() {
   if(document.hidden||controller) return;
   controller=new AbortController();
   const timer=setTimeout(()=>controller?.abort(),8000);
   try {
    const response=await fetch('/api/breaking',{cache:'no-store',signal:controller.signal});
    if(response.ok) {const value=await response.json();if(!disposed) setStory(value.story);}
   } catch {} finally {clearTimeout(timer);controller=null;}
  }
  void refresh();const interval=setInterval(()=>{setStory(s=>s&&new Date(s.breaking_until)<=new Date()?null:s);void refresh();},10000);
  document.addEventListener('visibilitychange',refresh);
  return ()=>{disposed=true;clearInterval(interval);controller?.abort();document.removeEventListener('visibilitychange',refresh);};
 },[]);
 if(!story) return null;
 return <aside className="breakingBanner" aria-label="Siste nyhet" aria-live="polite">
  <Link href={`/artikkel/${story.slug}`}><span className="breakingLabel"><span className="breakingDot" aria-hidden="true"/>SISTE</span>
   <strong>{story.tittel}</strong><span className="breakingFollow">Følg saken →</span></Link>
 </aside>;
}
