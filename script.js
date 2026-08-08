
function toggleMenu(){document.getElementById('mobileNav')?.classList.toggle('open')}
function filterRoutes(type){document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x.dataset.filter===type));document.querySelectorAll('.route-row[data-type]').forEach(x=>x.style.display=(type==='all'||x.dataset.type===type)?'grid':'none')}
function showLang(lang){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.lang===lang));document.querySelectorAll('.lang-panel').forEach(x=>x.style.display=x.dataset.lang===lang?'block':'none')}
function submitApplication(e){e.preventDefault();document.querySelector('.success').style.display='block';e.target.reset()}
