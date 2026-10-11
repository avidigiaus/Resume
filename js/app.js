/* ==========================================================================
   Digital IT Move — Resume Builder Frontend
   - Multi-step navigation with progress
   - Dynamic repeatable fields (education, certs, experience)
   - Tag input for skills
   - File preview with validation
   - localStorage save/load
   - Form submission to backend
   - Stripe payment flow for $1 second resume
   ========================================================================== */

(() => {
  'use strict';

  // -------- State --------
  const state = {
    step: 1,
    totalSteps: 7,
    skills: [],
    education: [],
    certs: [],
    experience: [],
    files: [],
    requestCount: 0, // server tells us
    pricing: { free: true, amount: 0 },
    submissionId: null,
  };

  // -------- DOM refs --------
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const form = $('#resumeForm');
  const steps = $$('.step');
  const progressFill = $('#progressFill');
  const progressSteps = $$('#progressSteps li');
  const submitBtn = $('#submitBtn');
  const consentEl = $('#consent');
  const loading = $('#loading');
  const toast = $('#toast');

  // -------- Utilities --------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const sanitize = (s) => {
    if (s == null) return '';
    return String(s)
      .replace(/[<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c]))
      .trim();
  };

  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const validUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
  const validMobile = (m) => /^[+\d][\d\s\-().]{6,}$/.test(m);

  // Safely parse a fetch response as JSON — even if the server returns HTML
  // (e.g. Express default error page or the SPA fallback). Without this, the
  // user sees an opaque "Unexpected token '<'" JSON.parse error.
  async function safeJson(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // Read body once as text
    const text = await res.text();
    if (ct.includes('application/json')) {
      try { return JSON.parse(text); } catch { /* fall through */ }
    }
    // If it looks like HTML, the API likely returned a fallback page
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(
        'The server is not responding correctly. ' +
        'If you opened this page directly (file://), please run "npm start" in the project folder and visit http://localhost:3000 instead.'
      );
    }
    // Last attempt
    try { return JSON.parse(text); } catch {
      throw new Error(`Server returned an unexpected response (HTTP ${res.status}).`);
    }
  }

  function showToast(msg, type = 'success', ms = 3500) {
    toast.textContent = msg;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function setError(fieldName, msg) {
    const errEl = $(`.err[data-for="${fieldName}"]`);
    if (errEl) errEl.textContent = msg || '';
    const input = $(`[name="${fieldName}"]`);
    if (input) input.classList.toggle('invalid', !!msg);
  }

  function clearErrors() {
    $$('.err').forEach((e) => (e.textContent = ''));
    $$('.invalid').forEach((e) => e.classList.remove('invalid'));
  }

  // -------- Progress --------
  function updateProgress() {
    const pct = (state.step / state.totalSteps) * 100;
    progressFill.style.width = `${pct}%`;
    progressSteps.forEach((li, idx) => {
      const n = idx + 1;
      li.classList.toggle('active', n === state.step);
      li.classList.toggle('done', n < state.step);
    });
  }

  function showStep(n) {
    state.step = n;
    steps.forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === n));
    updateProgress();
    window.scrollTo({ top: $('#form').offsetTop - 80, behavior: 'smooth' });
    if (n === 7) renderReview();
  }

  // -------- Multi-step navigation --------
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'next') {
      if (validateStep(state.step)) showStep(state.step + 1);
    } else if (action === 'prev') {
      if (state.step > 1) showStep(state.step - 1);
    } else if (action === 'add-education') {
      addEducation();
    } else if (action === 'add-cert') {
      addCert();
    } else if (action === 'add-exp') {
      addExperience();
    } else if (action === 'save') {
      saveProgress();
      showToast('Progress saved locally.');
    } else if (action === 'close-modal') {
      $('#successModal').setAttribute('aria-hidden', 'true');
    } else if (action === 'new-resume') {
      $('#successModal').setAttribute('aria-hidden', 'true');
      form.reset();
      state.skills = []; renderSkills();
      clearRepeat('educationList'); addEducation();
      clearRepeat('certList');
      clearRepeat('expList');
      state.files = []; renderFiles();
      showStep(1);
      // bump the request count (since they just submitted)
      state.requestCount = (state.requestCount || 0) + 1;
    } else if (action === 'pay-then-submit') {
      startPayment();
    }
  });

  // -------- Validation per step --------
  function validateStep(step) {
    clearErrors();
    let ok = true;
    const reqErr = (name) => { setError(name, 'This field is required'); ok = false; };

    if (step === 1) {
      const fn = $('#fullName').value.trim();
      const ct = $('#currentTitle').value.trim();
      if (!fn) reqErr('fullName');
      if (!ct) reqErr('currentTitle');
    } else if (step === 5) {
      const m = $('#mobile').value.trim();
      const e = $('#email').value.trim();
      if (!m) reqErr('mobile');
      else if (!validMobile(m)) { setError('mobile', 'Enter a valid phone number'); ok = false; }
      if (!e) reqErr('email');
      else if (!validEmail(e)) { setError('email', 'Enter a valid email'); ok = false; }
      ['linkedin', 'github', 'portfolio', 'otherLink'].forEach((id) => {
        const v = $('#' + id).value.trim();
        if (v && !validUrl(v)) { setError(id, 'Enter a valid URL (https://...)'); ok = false; }
      });
    } else if (step === 6) {
      const s = $('#resumeStyle').value;
      const c = $('#resumeColor').value;
      if (!s) reqErr('resumeStyle');
      if (!c) reqErr('resumeColor');
    } else if (step === 7) {
      if (!consentEl.checked) { setError('consent', 'You must confirm to submit'); ok = false; }
    }
    if (!ok) showToast('Please complete the required fields.', 'error');
    return ok;
  }

  // -------- Repeatable blocks --------
  function addEducation(data = {}) {
    const list = $('#educationList');
    const i = state.education.length;
    const id = `edu-${i}-${uid()}`;
    const block = document.createElement('div');
    block.className = 'repeat';
    block.dataset.id = id;
    block.innerHTML = `
      <div class="repeat-head">
        <span>Education #${i + 1}</span>
        <button type="button" class="repeat-remove">Remove</button>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>Highest Qualification</label>
          <input type="text" data-edu="${id}" data-k="qualification" value="${sanitize(data.qualification || '')}" placeholder="e.g., Bachelor's" />
        </div>
        <div class="field">
          <label>Course / Degree</label>
          <input type="text" data-edu="${id}" data-k="course" value="${sanitize(data.course || '')}" placeholder="e.g., B.Tech in Computer Science" />
        </div>
        <div class="field">
          <label>College / University</label>
          <input type="text" data-edu="${id}" data-k="college" value="${sanitize(data.college || '')}" placeholder="e.g., MIT" />
        </div>
        <div class="field">
          <label>Passing Year</label>
          <input type="text" data-edu="${id}" data-k="year" value="${sanitize(data.year || '')}" placeholder="e.g., 2023" />
        </div>
      </div>
      <div class="field">
        <label>Education Description</label>
        <textarea data-edu="${id}" data-k="description" rows="2" placeholder="Honors, GPA, key coursework, etc.">${sanitize(data.description || '')}</textarea>
      </div>
    `;
    list.appendChild(block);
    state.education.push({ id, ...data });
    block.querySelector('.repeat-remove').addEventListener('click', () => {
      block.remove();
      state.education = state.education.filter((e) => e.id !== id);
      refreshIndexes('Education');
    });
  }

  function addCert(data = {}) {
    const list = $('#certList');
    const i = state.certs.length;
    const id = `cert-${i}-${uid()}`;
    const block = document.createElement('div');
    block.className = 'repeat';
    block.dataset.id = id;
    block.innerHTML = `
      <div class="repeat-head">
        <span>Certification #${i + 1}</span>
        <button type="button" class="repeat-remove">Remove</button>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>Certification Name</label>
          <input type="text" data-cert="${id}" data-k="name" value="${sanitize(data.name || '')}" placeholder="e.g., AWS Solutions Architect" />
        </div>
        <div class="field">
          <label>Issuing Organization</label>
          <input type="text" data-cert="${id}" data-k="org" value="${sanitize(data.org || '')}" placeholder="e.g., Amazon" />
        </div>
        <div class="field">
          <label>Year</label>
          <input type="text" data-cert="${id}" data-k="year" value="${sanitize(data.year || '')}" placeholder="e.g., 2024" />
        </div>
        <div class="field">
          <label>Certificate (optional)</label>
          <input type="file" data-cert="${id}" data-k="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" />
        </div>
      </div>
    `;
    list.appendChild(block);
    state.certs.push({ id, ...data });
    block.querySelector('.repeat-remove').addEventListener('click', () => {
      block.remove();
      state.certs = state.certs.filter((c) => c.id !== id);
      refreshIndexes('Certification');
    });
  }

  function addExperience(data = {}) {
    const list = $('#expList');
    const i = state.experience.length;
    const id = `exp-${i}-${uid()}`;
    const block = document.createElement('div');
    block.className = 'repeat';
    block.dataset.id = id;
    block.innerHTML = `
      <div class="repeat-head">
        <span>Experience #${i + 1}</span>
        <button type="button" class="repeat-remove">Remove</button>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>Job Title</label>
          <input type="text" data-exp="${id}" data-k="title" value="${sanitize(data.title || '')}" placeholder="e.g., Frontend Engineer" />
        </div>
        <div class="field">
          <label>Company / Organization</label>
          <input type="text" data-exp="${id}" data-k="company" value="${sanitize(data.company || '')}" placeholder="e.g., Acme Corp" />
        </div>
        <div class="field">
          <label>Employment Duration</label>
          <input type="text" data-exp="${id}" data-k="duration" value="${sanitize(data.duration || '')}" placeholder="e.g., Jan 2022 – Present" />
        </div>
      </div>
      <div class="field">
        <label>Responsibilities</label>
        <textarea data-exp="${id}" data-k="responsibilities" rows="2" placeholder="What did you do?">${sanitize(data.responsibilities || '')}</textarea>
      </div>
      <div class="field">
        <label>Achievements</label>
        <textarea data-exp="${id}" data-k="achievements" rows="2" placeholder="Key wins / metrics.">${sanitize(data.achievements || '')}</textarea>
      </div>
    `;
    list.appendChild(block);
    state.experience.push({ id, ...data });
    block.querySelector('.repeat-remove').addEventListener('click', () => {
      block.remove();
      state.experience = state.experience.filter((x) => x.id !== id);
      refreshIndexes('Experience');
    });
  }

  function refreshIndexes(label) {
    $$(`#educationList .repeat, #certList .repeat, #expList .repeat`).forEach((b, i) => {
      const head = b.querySelector('.repeat-head span');
      if (head) head.textContent = `${label} #${i + 1}`;
    });
  }

  function clearRepeat(id) {
    const list = $('#' + id);
    if (list) list.innerHTML = '';
  }

  // -------- Skills (tag input) --------
  function renderSkills() {
    const wrap = $('#skillInputWrap');
    const input = $('#skillInput');
    $$('.tag', wrap).forEach((t) => t.remove());
    state.skills.forEach((s, idx) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `${sanitize(s)}<button type="button" data-skill-idx="${idx}" aria-label="Remove ${sanitize(s)}">×</button>`;
      wrap.insertBefore(tag, input);
    });
  }

  function addSkill(text) {
    const t = (text || '').trim().replace(/,$/, '');
    if (!t) return;
    if (state.skills.includes(t)) return;
    if (state.skills.length >= 30) { showToast('Max 30 skills', 'error'); return; }
    state.skills.push(t);
    renderSkills();
  }

  $('#skillInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addSkill(e.target.value);
      e.target.value = '';
    } else if (e.key === 'Backspace' && !e.target.value && state.skills.length) {
      state.skills.pop(); renderSkills();
    }
  });
  $('#skillInput').addEventListener('blur', (e) => {
    if (e.target.value.trim()) { addSkill(e.target.value); e.target.value = ''; }
  });
  $('#skillInputWrap').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-skill-idx]');
    if (!btn) return;
    state.skills.splice(Number(btn.dataset.skillIdx), 1);
    renderSkills();
  });

  // -------- Chip groups (preferences) --------
  $$('.chip-group').forEach((group) => {
    const name = group.dataset.name;
    const hidden = $('#' + name);
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      group.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      hidden.value = chip.dataset.value;
      setError(name, '');
    });
  });

  // -------- File preview --------
  const ALLOWED = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
  const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
  const MAX_FILES = 5;

  function renderFiles() {
    const list = $('#filePreview');
    list.innerHTML = '';
    state.files.forEach((f, idx) => {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      const row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML = `
        <span class="file-icon">${ext.replace('.', '').toUpperCase().slice(0, 3) || 'FILE'}</span>
        <span class="file-name">${sanitize(f.name)}</span>
        <span class="file-size">${(f.size / 1024).toFixed(0)} KB</span>
        <button type="button" class="file-remove" data-idx="${idx}" aria-label="Remove">×</button>
      `;
      list.appendChild(row);
    });
  }

  $('#documents').addEventListener('change', (e) => {
    const newFiles = Array.from(e.target.files || []);
    newFiles.forEach((f) => {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED.includes(ext)) { showToast(`Unsupported file: ${f.name}`, 'error'); return; }
      if (f.size > MAX_FILE_SIZE) { showToast(`File too large (max 8MB): ${f.name}`, 'error'); return; }
      if (state.files.length >= MAX_FILES) { showToast(`Max ${MAX_FILES} files`, 'error'); return; }
      state.files.push(f);
    });
    e.target.value = '';
    renderFiles();
  });

  $('#filePreview').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-idx]');
    if (!btn) return;
    state.files.splice(Number(btn.dataset.idx), 1);
    renderFiles();
  });

  // -------- Profile image (single) --------
  const profileImgInput = $('#profileImage');
  profileImgInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { showToast('Profile image must be under 5MB', 'error'); e.target.value = ''; return; }
    if (!['image/png', 'image/jpeg'].includes(f.type)) { showToast('Profile image must be PNG or JPG', 'error'); e.target.value = ''; return; }
  });

  // -------- Consent toggle enables submit --------
  consentEl.addEventListener('change', () => {
    submitBtn.disabled = !consentEl.checked;
    if (consentEl.checked) setError('consent', '');
  });

  // -------- Review rendering --------
  function renderReview() {
    const v = (id) => sanitize($('#' + id).value) || '—';
    const getRepeat = (sel, k) => $$(sel).map((el) => el.value.trim()).filter(Boolean);

    const edu = $$('#educationList .repeat').map((b) => {
      const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value.trim() || '';
      return { qualification: get('qualification'), course: get('course'), college: get('college'), year: get('year'), description: get('description') };
    }).filter((e) => Object.values(e).some(Boolean));

    const certs = $$('#certList .repeat').map((b) => {
      const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value.trim() || '';
      return { name: get('name'), org: get('org'), year: get('year') };
    }).filter((c) => Object.values(c).some(Boolean));

    const exp = $$('#expList .repeat').map((b) => {
      const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value.trim() || '';
      return { title: get('title'), company: get('company'), duration: get('duration'), responsibilities: get('responsibilities'), achievements: get('achievements') };
    }).filter((e) => Object.values(e).some(Boolean));

    const blocks = [
      { key: 1, title: 'Personal Information', rows: [
        ['Full Name', v('fullName')],
        ['Current Title', v('currentTitle')],
        ['Current Organization', v('currentOrg')],
        ['Years of Experience', v('yearsExperience') || '—'],
        ['Target Job', v('targetJob') || '—'],
        ['About', $('#about').value.trim() || '—'],
        ['Skills', state.skills.length ? 'taglist' : '—'],
      ]},
      { key: 2, title: 'Education', rows: edu.length ? [['Records', 'edu']] : [['Status', 'No education added']] },
      { key: 2, title: 'Certifications', rows: certs.length ? [['Records', 'certs']] : [['Status', 'No certifications added']] },
      { key: 3, title: 'Experience', rows: exp.length ? [['Records', 'exp']] : [['Status', 'No experience added (optional)']] },
      { key: 5, title: 'Contact', rows: [
        ['Mobile', v('mobile')], ['Email', v('email')],
        ['LinkedIn', v('linkedin') || '—'], ['GitHub', v('github') || '—'],
        ['Portfolio', v('portfolio') || '—'], ['Location', v('location') || '—'],
        ['Other Link', v('otherLink') || '—'],
        ['Files', state.files.length ? `${state.files.length} file(s) attached` : 'No files'],
      ]},
      { key: 6, title: 'Preferences', rows: [
        ['Resume Style', v('resumeStyle') || '—'],
        ['Resume Color', v('resumeColor') || '—'],
      ]},
    ];

    const c = $('#reviewContainer');
    c.innerHTML = blocks.map((b) => `
      <div class="review-block">
        <div class="review-head">
          <h4>${b.title}</h4>
          <button type="button" data-edit="${b.key}">Edit</button>
        </div>
        ${b.rows.map(([k, val]) => {
          if (val === 'taglist') {
            return `<div class="review-row"><div class="k">${k}</div><div class="v"><div class="review-tags">${state.skills.map((s) => `<span class="tag">${sanitize(s)}</span>`).join('')}</div></div></div>`;
          }
          if (val === 'edu') {
            return `<div class="review-row"><div class="k">${k}</div><div class="v">${edu.map((e) => `<div style="margin-bottom:6px;"><strong>${sanitize(e.qualification || '—')}</strong> &middot; ${sanitize(e.course || '—')}<br><small>${sanitize(e.college || '—')} ${e.year ? '· ' + sanitize(e.year) : ''}</small>${e.description ? '<br><small style="color:var(--text-mute)">' + sanitize(e.description) + '</small>' : ''}</div>`).join('')}</div></div>`;
          }
          if (val === 'certs') {
            return `<div class="review-row"><div class="k">${k}</div><div class="v">${certs.map((x) => `<div>• <strong>${sanitize(x.name || '—')}</strong> ${x.org ? '— ' + sanitize(x.org) : ''} ${x.year ? '(' + sanitize(x.year) + ')' : ''}</div>`).join('')}</div></div>`;
          }
          if (val === 'exp') {
            return `<div class="review-row"><div class="k">${k}</div><div class="v">${exp.map((e) => `<div style="margin-bottom:8px;"><strong>${sanitize(e.title || '—')}</strong> ${e.company ? '@ ' + sanitize(e.company) : ''} ${e.duration ? '· ' + sanitize(e.duration) : ''}${e.responsibilities ? '<br><small>' + sanitize(e.responsibilities) + '</small>' : ''}${e.achievements ? '<br><small style="color:#86efac">' + sanitize(e.achievements) + '</small>' : ''}</div>`).join('')}</div></div>`;
          }
          const muted = val === '—' ? 'muted' : '';
          return `<div class="review-row"><div class="k">${k}</div><div class="v ${muted}">${sanitize(val)}</div></div>`;
        }).join('')}
      </div>
    `).join('');

    c.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => showStep(Number(btn.dataset.edit)));
    });

    renderPricingReminder();
  }

  function renderPricingReminder() {
    const rem = $('#pricingReminder');
    if (state.pricing.free) {
      rem.innerHTML = `
        <div>
          <div class="lbl">Resume Creation Cost</div>
          <div class="amt">FREE 🎉</div>
        </div>
        <div style="text-align:right;">
          <div class="lbl">Your first resume is on us</div>
          <div style="font-size:12px;color:var(--text-mute);">From your 2nd request: $1 / resume</div>
        </div>
      `;
    } else {
      rem.innerHTML = `
        <div>
          <div class="lbl">Resume Creation Cost</div>
          <div class="amt">$1.00</div>
        </div>
        <button type="button" class="pay-btn" data-action="pay-then-submit">Pay $1 & Submit</button>
      `;
    }
  }

  // -------- LocalStorage save / load --------
  const STORAGE_KEY = 'ditmove_resume_draft_v1';
  function collectFormData() {
    const data = {
      fullName: $('#fullName').value,
      currentTitle: $('#currentTitle').value,
      currentOrg: $('#currentOrg').value,
      yearsExperience: $('#yearsExperience').value,
      targetJob: $('#targetJob').value,
      mobile: $('#mobile').value,
      email: $('#email').value,
      linkedin: $('#linkedin').value,
      github: $('#github').value,
      portfolio: $('#portfolio').value,
      location: $('#location').value,
      otherLink: $('#otherLink').value,
      about: $('#about').value,
      resumeStyle: $('#resumeStyle').value,
      resumeColor: $('#resumeColor').value,
      education: $$('#educationList .repeat').map((b) => {
        const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value || '';
        return { qualification: get('qualification'), course: get('course'), college: get('college'), year: get('year'), description: get('description') };
      }),
      certs: $$('#certList .repeat').map((b) => {
        const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value || '';
        return { name: get('name'), org: get('org'), year: get('year') };
      }),
      experience: $$('#expList .repeat').map((b) => {
        const get = (k) => b.querySelector(`[data-k="${k}"]`)?.value || '';
        return { title: get('title'), company: get('company'), duration: get('duration'), responsibilities: get('responsibilities'), achievements: get('achievements') };
      }),
      skills: [...state.skills],
      savedAt: new Date().toISOString(),
    };
    return data;
  }

  function saveProgress() {
    try {
      const data = collectFormData();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* quota — ignore */ }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      $('#fullName').value = d.fullName || '';
      $('#currentTitle').value = d.currentTitle || '';
      $('#currentOrg').value = d.currentOrg || '';
      $('#yearsExperience').value = d.yearsExperience || '';
      $('#targetJob').value = d.targetJob || '';
      $('#mobile').value = d.mobile || '';
      $('#email').value = d.email || '';
      $('#linkedin').value = d.linkedin || '';
      $('#github').value = d.github || '';
      $('#portfolio').value = d.portfolio || '';
      $('#location').value = d.location || '';
      $('#otherLink').value = d.otherLink || '';
      $('#about').value = d.about || '';
      if (d.resumeStyle) { $('#resumeStyle').value = d.resumeStyle; markChip('resumeStyle', d.resumeStyle); }
      if (d.resumeColor) { $('#resumeColor').value = d.resumeColor; markChip('resumeColor', d.resumeColor); }

      clearRepeat('educationList');
      (d.education || []).forEach((e) => addEducation(e));
      clearRepeat('certList');
      (d.certs || []).forEach((c) => addCert(c));
      clearRepeat('expList');
      (d.experience || []).forEach((x) => addExperience(x));

      state.skills = d.skills || [];
      renderSkills();
      return true;
    } catch { return false; }
  }

  function markChip(name, value) {
    const group = document.querySelector(`.chip-group[data-name="${name}"]`);
    if (!group) return;
    group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', c.dataset.value === value));
  }

  // -------- Submit --------
  async function submitForm(opts = {}) {
    if (!validateStep(7)) return;
    if (state.files.length === 0 && $('#profileImage').files.length === 0) {
      // Not blocking — files are optional
    }

    submitBtn.classList.add('loading');
    submitBtn.disabled = true;
    loading.setAttribute('aria-hidden', 'false');

    const fd = new FormData();
    const data = collectFormData();
    Object.entries(data).forEach(([k, v]) => {
      if (k === 'education' || k === 'certs' || k === 'experience') {
        fd.append(k, JSON.stringify(v));
      } else if (k !== 'savedAt') {
        fd.append(k, v ?? '');
      }
    });
    // Honeypot
    fd.append('company_hp', $('#company_hp').value);
    // Files
    state.files.forEach((f) => fd.append('documents', f, f.name));
    const profileImg = $('#profileImage').files[0];
    if (profileImg) fd.append('profileImage', profileImg, profileImg.name);
    if (opts.paid) fd.append('paid', 'true');
    if (opts.sessionId) fd.append('sessionId', opts.sessionId);

    try {
      const res = await fetch('/api/resume/submit', { method: 'POST', body: fd });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error || `Submission failed (HTTP ${res.status})`);
      state.submissionId = json.submissionId;
      // Bump request count
      state.requestCount = (state.requestCount || 0) + 1;
      state.pricing = { free: state.requestCount === 1, amount: state.requestCount > 1 ? 1 : 0 };

      // Clear saved progress
      try { localStorage.removeItem(STORAGE_KEY); } catch {}

      // Show success modal
      const meta = $('#successMeta');
      meta.innerHTML = `
        <div><strong>Submission ID:</strong> ${sanitize(json.submissionId)}</div>
        <div><strong>Request #:</strong> ${state.requestCount} ${state.requestCount === 1 ? '(FREE)' : '($1 paid)'}</div>
        <div><strong>Submitted:</strong> ${new Date().toLocaleString()}</div>
      `;
      $('#successModal').setAttribute('aria-hidden', 'false');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Submission failed. Please try again.', 'error', 6000);
    } finally {
      submitBtn.classList.remove('loading');
      submitBtn.disabled = !consentEl.checked;
      loading.setAttribute('aria-hidden', 'true');
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.pricing.free) {
      await submitForm();
    } else {
      // For paid: must go through Stripe first
      await startPayment();
    }
  });

  // -------- Stripe payment flow --------
  async function startPayment() {
    submitBtn.classList.add('loading');
    try {
      // Save progress first so we can recover after Stripe redirect
      saveProgress();
      const res = await fetch('/api/resume/create-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json.error || `Payment setup failed (HTTP ${res.status})`);
      if (json.url) {
        window.location.href = json.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Payment could not be started.', 'error', 6000);
      submitBtn.classList.remove('loading');
    }
  }

  // -------- Server status (request count) --------
  async function fetchStatus() {
    try {
      const res = await fetch('/api/resume/status', { credentials: 'same-origin' });
      if (!res.ok) return;
      const json = await safeJson(res);
      state.requestCount = json.requestCount || 0;
      state.pricing = { free: state.requestCount < 1, amount: state.requestCount >= 1 ? 1 : 0 };
    } catch (e) { /* ignore — server may not be running yet */ }
  }

  // -------- Init --------
  function init() {
    updateProgress();
    addEducation();
    addCert();
    addExperience();
    renderSkills();
    const restored = loadProgress();
    if (restored) showToast('We restored your saved progress.');
    fetchStatus();

    // Check for ?paid=1 return from Stripe
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') === '1' && params.get('session_id')) {
      // Auto-submit after returning from Stripe
      setTimeout(() => submitForm({ paid: true, sessionId: params.get('session_id') }), 600);
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname + '#form');
    } else if (params.get('paid') === 'cancelled') {
      showToast('Payment cancelled. You can try again.', 'error');
      window.history.replaceState({}, '', window.location.pathname + '#form');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
