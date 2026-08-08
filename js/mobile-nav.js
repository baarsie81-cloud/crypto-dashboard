function setActive(button){document.querySelectorAll('.mobile-nav button').forEach(item=>item.classList.toggle('active',item===button));}
function scrollToTarget(id,button){const target=document.getElementById(id);if(!target)return;target.scrollIntoView({behavior:'smooth',block:'start'});setActive(button);}
function openBacktest(button){const drawer=document.getElementById('infoDrawer');if(!drawer)return;document.getElementById('settingsDialog')?.close?.();drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');drawer.querySelector('.drawer-content')?.focus();setActive(button);}
function bind(){const nav=document.querySelector('.mobile-nav');if(!nav)return;const buttons=[...nav.querySelectorAll('button')];const decision=buttons.find(b=>b.dataset.mobileTarget==='scannerView');const chart=buttons.find(b=>b.dataset.mobileTarget==='chartView');const backtest=document.getElementById('mobileInfoButton');
  decision?.addEventListener('click',event=>{event.stopImmediatePropagation();scrollToTarget('decisionDesk',decision);},true);
  chart?.addEventListener('click',event=>{event.stopImmediatePropagation();scrollToTarget('chartView',chart);},true);
  backtest?.addEventListener('click',event=>{event.stopImmediatePropagation();openBacktest(backtest);},true);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
