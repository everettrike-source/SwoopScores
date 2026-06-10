// SwoopScores — Background Service Worker
// Handles all RateMyProfessor API calls to avoid CORS issues from the content script.

const RMP_GRAPHQL_URL = 'https://www.ratemyprofessors.com/graphql';

// Public auth key embedded in every RMP page (base64 of "test:test").
// If requests start returning 401, inspect the RMP page source for REACT_APP_GRAPHQL_AUTH.
const RMP_AUTH = 'dGVzdDp0ZXN0';

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const SEARCH_SCHOOLS_QUERY = `
  query NewSearchSchoolsQuery($query: SchoolSearchQuery!) {
    newSearch {
      schools(query: $query) {
        edges {
          node {
            id
            legacyId
            name
            city
            state
          }
        }
      }
    }
  }
`;

const SEARCH_TEACHERS_QUERY = `
  query NewSearchTeachersQuery($query: TeacherSearchQuery!) {
    newSearch {
      teachers(query: $query) {
        edges {
          node {
            id
            legacyId
            firstName
            lastName
            department
            school {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const GET_TEACHER_RATINGS_QUERY = `
  query TeacherRatingsPageQuery($id: ID!) {
    node(id: $id) {
      __typename
      ... on Teacher {
        id
        legacyId
        firstName
        lastName
        avgRating
        avgDifficulty
        numRatings
        wouldTakeAgainPercent
        department
        school {
          name
        }
      }
    }
  }
`;

// ─── RMP API helpers ──────────────────────────────────────────────────────────

async function rmpQuery(query, variables) {
  const response = await fetch(RMP_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${RMP_AUTH}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401) {
    console.warn(
      '[SwoopScores] RMP returned 401 — the auth key may have rotated. ' +
        'Check REACT_APP_GRAPHQL_AUTH in the RMP page source.'
    );
    throw new Error('RMP auth failed (401)');
  }

  if (!response.ok) {
    throw new Error(`RMP request failed: HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    console.error('[SwoopScores] GraphQL errors:', json.errors);
    throw new Error(json.errors[0]?.message ?? 'GraphQL error');
  }

  return json.data;
}

async function searchProfessor(professorName) {
  const schoolId = await getSchoolId();
  console.log(`[SwoopScores] Searching RMP for "${professorName}" at school ${schoolId}…`);
  const data = await rmpQuery(SEARCH_TEACHERS_QUERY, {
    query: { schoolID: schoolId, text: professorName },
  });

  const edges = data?.newSearch?.teachers?.edges ?? [];
  if (edges.length === 0) {
    console.log(`[SwoopScores] No RMP results for "${professorName}"`);
    return null;
  }

  // Return the best match — the first result is typically the closest name match.
  const teacher = edges[0].node;
  console.log(
    `[SwoopScores] Found teacher: ${teacher.firstName} ${teacher.lastName} (id: ${teacher.id})`
  );
  return teacher;
}

async function getTeacherRatings(teacherId) {
  console.log(`[SwoopScores] Fetching ratings for teacher id: ${teacherId}`);
  const data = await rmpQuery(GET_TEACHER_RATINGS_QUERY, { id: teacherId });
  const teacher = data?.node;

  if (!teacher || teacher.__typename !== 'Teacher') {
    throw new Error('Unexpected node type returned from RMP');
  }

  return teacher;
}

// ─── School ID lookup ─────────────────────────────────────────────────────────
// Dynamically resolves the University of Utah's RMP school ID and caches it in
// chrome.storage.local (persistent across browser restarts). This avoids the
// brittleness of a hardcoded ID that may be wrong or change over time.

const SCHOOL_ID_CACHE_KEY = 'swoop_school_id';

async function getSchoolId() {
  const stored = await chrome.storage.local.get(SCHOOL_ID_CACHE_KEY);
  if (stored[SCHOOL_ID_CACHE_KEY]) {
    console.log(`[SwoopScores] Using cached school ID: ${stored[SCHOOL_ID_CACHE_KEY]}`);
    return stored[SCHOOL_ID_CACHE_KEY];
  }

  console.log('[SwoopScores] Looking up University of Utah school ID from RMP…');
  const data = await rmpQuery(SEARCH_SCHOOLS_QUERY, {
    query: { text: 'University of Utah' },
  });
  const edges = data?.newSearch?.schools?.edges ?? [];

  if (edges.length === 0) throw new Error('No schools returned from RMP school search');

  // Prefer an exact name + state match; fall back to the first result.
  const match =
    edges.find((e) => e.node.state === 'UT' && e.node.name === 'University of Utah') ??
    edges[0];

  const schoolId = match.node.id;
  console.log(
    `[SwoopScores] Resolved school ID: ${schoolId} (legacyId: ${match.node.legacyId}, name: "${match.node.name}")`
  );

  await chrome.storage.local.set({ [SCHOOL_ID_CACHE_KEY]: schoolId });
  return schoolId;
}

// ─── Session cache ────────────────────────────────────────────────────────────
// Uses chrome.storage.session so the cache is cleared when the browser closes.

const CACHE_PREFIX = 'swoop_cache_';

async function getCached(key) {
  const result = await chrome.storage.session.get(CACHE_PREFIX + key);
  return result[CACHE_PREFIX + key] ?? null;
}

async function setCached(key, value) {
  await chrome.storage.session.set({ [CACHE_PREFIX + key]: value });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

async function fetchRMPData(professorName) {
  const cacheKey = professorName.trim().toLowerCase();

  const cached = await getCached(cacheKey);
  if (cached) {
    console.log(`[SwoopScores] Cache hit for "${professorName}"`);
    return cached;
  }

  const teacher = await searchProfessor(professorName);
  if (!teacher) {
    return { error: `No RMP profile found for "${professorName}"` };
  }

  const ratings = await getTeacherRatings(teacher.id);

  const result = {
    name: `${ratings.firstName} ${ratings.lastName}`,
    department: ratings.department ?? teacher.department ?? '',
    avgRating: ratings.avgRating,
    avgDifficulty: ratings.avgDifficulty,
    numRatings: ratings.numRatings,
    wouldTakeAgainPercent: ratings.wouldTakeAgainPercent,
    profileUrl: `https://www.ratemyprofessors.com/professor/${ratings.legacyId}`,
  };

  await setCached(cacheKey, result);
  console.log(`[SwoopScores] Cached result for "${professorName}":`, result);
  return result;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'fetchRMP') return false;

  const professorName = message.professorName?.trim();
  if (!professorName) {
    sendResponse({ error: 'No professor name provided' });
    return false;
  }

  // Must return true to keep the message channel open for async response.
  fetchRMPData(professorName)
    .then(sendResponse)
    .catch((err) => {
      console.error('[SwoopScores] Error fetching RMP data:', err);
      sendResponse({ error: err.message ?? 'Unknown error' });
    });

  return true;
});

console.log('[SwoopScores] Background service worker started.');
