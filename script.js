// Use async/await and add category support + detail rendering
document.addEventListener("DOMContentLoaded", () => {
  init();
});

// Language detection and Bootstrap CSS loader
(function () {
  try {
    const userLang =
      navigator.language ||
      navigator.userLanguage ||
      document.documentElement.lang ||
      "en";
    const lang = userLang.split("-")[0].toLowerCase();
    const rtlLangs = [
      "ar",
      "he",
      "fa",
      "ur",
      "ps",
      "sd",
      "ug",
      "dv",
      "ku",
      "yi",
    ];
    const isRtl = rtlLangs.includes(lang);
    // Set html lang and direction
    document.documentElement.lang = userLang;
    document.documentElement.dir = isRtl ? "rtl" : "ltr";

    // Insert the appropriate Bootstrap CSS (RTL or LTR) before other styles
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = isRtl
      ? "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.rtl.min.css"
      : "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css";
    // Add a data attribute so other scripts/styles can detect
    link.dataset.bootstrap = isRtl ? "rtl" : "ltr";
    // Insert at the start of head so it appears before style.css
    const head = document.head || document.getElementsByTagName("head")[0];
    if (head.firstChild) head.insertBefore(link, head.firstChild);
    else head.appendChild(link);
    document.documentElement.dataset.bootstrapRtl = isRtl ? "1" : "0";

    // Log load success / failure for the CSS so devs can see issues in console
    link.onload = () => console.info("Bootstrap CSS loaded (", link.href, ")");
    link.onerror = (e) =>
      console.warn("Failed to load Bootstrap CSS:", link.href, e);

    // Inject Bootstrap JS bundle dynamically and report load status
    const bsScript = document.createElement("script");
    bsScript.src =
      "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js";
    bsScript.defer = true;
    bsScript.onload = () => console.info("Bootstrap JS bundle loaded.");
    bsScript.onerror = (e) =>
      console.warn("Failed to load Bootstrap JS bundle:", bsScript.src, e);
    // Append to head so it loads early but after CSS
    head.appendChild(bsScript);
  } catch (e) {
    console.warn("Language detection failed, falling back to LTR", e);
  }
})();

// Keep a cached list of category names so we can fetch "all" recipes
let categoriesList = [];

// UI / filter state
const state = {
  area: "",
  category: "all",
  favoritesOnly: false,
  search: "",
  page: 1,
  pageSize: 8,
};

/* ---------- Favorites helpers (localStorage) ---------- */
function getFavoritesMap() {
  try {
    const raw = localStorage.getItem("favorites");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Failed to parse favorites from localStorage", e);
    return {};
  }
}

function saveFavoritesMap(map) {
  try {
    localStorage.setItem("favorites", JSON.stringify(map));
  } catch (e) {
    console.error("Failed to save favorites to localStorage", e);
  }
}

function isFavorited(id) {
  const map = getFavoritesMap();
  return Boolean(map[id]);
}

function toggleFavorite(meal) {
  const map = getFavoritesMap();
  if (map[meal.idMeal]) {
    delete map[meal.idMeal];
  } else {
    // store minimal necessary fields so favorites can be shown offline
    map[meal.idMeal] = {
      idMeal: meal.idMeal,
      strMeal: meal.strMeal,
      strMealThumb: meal.strMealThumb,
    };
  }
  saveFavoritesMap(map);
}

/* ---------- Init & wiring ---------- */
async function init() {
  const areaSelect = document.getElementById("area-select");
  const categorySelect = document.getElementById("category-select");
  const showFavBtn = document.getElementById("show-favorites-btn");
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");

  // Reset selects to default option
  areaSelect.innerHTML = '<option value="">Select Area</option>';
  categorySelect.innerHTML = '<option value="all">All Categories</option>';

  try {
    // Fetch areas
    const areasRes = await fetch(
      "https://www.themealdb.com/api/json/v1/1/list.php?a=list"
    );
    const areasData = await areasRes.json();
    if (areasData.meals) {
      areasData.meals.forEach((areaObj) => {
        const option = document.createElement("option");
        option.value = areaObj.strArea;
        option.textContent = areaObj.strArea;
        areaSelect.appendChild(option);
      });
    }

    // Fetch categories (as requested)
    const categoriesRes = await fetch(
      "https://www.themealdb.com/api/json/v1/1/list.php?c=list"
    );
    const categoriesData = await categoriesRes.json();
    if (categoriesData.meals) {
      // cache list for 'all' fetching
      categoriesList = categoriesData.meals.map((c) => c.strCategory);
      categoriesList.forEach((cat) => {
        const option = document.createElement("option");
        option.value = cat;
        option.textContent = cat;
        categorySelect.appendChild(option);
      });
    }
  } catch (err) {
    console.error("Error fetching area/category lists:", err);
  }

  // Wire up area select change (update state and re-render)
  areaSelect.addEventListener("change", function () {
    state.area = this.value;
    state.page = 1;
    applyFilters();
  });

  // Wire category select to update state and re-render
  categorySelect.addEventListener("change", function () {
    state.category = this.value || "all";
    state.page = 1;
    applyFilters();
  });

  // Search handlers
  if (searchBtn && searchInput) {
    searchBtn.addEventListener("click", () => {
      state.search = searchInput.value.trim();
      state.page = 1;
      applyFilters();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        state.search = searchInput.value.trim();
        state.page = 1;
        applyFilters();
      }
    });
  }

  // Toggle favorites-only filter
  showFavBtn.addEventListener("click", () => {
    state.favoritesOnly = !state.favoritesOnly;
    showFavBtn.classList.toggle("active", state.favoritesOnly);
    state.page = 1;
    applyFilters();
  });

  // Load initial view according to defaults (category 'all')
  attachPaginationHandlers();
  applyFilters();
}

// Fetch meals for every category and render a deduplicated list
// Return combined list of meals across all categories (deduped)
async function getAllMeals() {
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "Loading all recipes...";

  if (!categoriesList || categoriesList.length === 0) {
    // fallback: try to fetch categories directly
    try {
      const resp = await fetch(
        "https://www.themealdb.com/api/json/v1/1/list.php?c=list"
      );
      const data = await resp.json();
      categoriesList = data.meals ? data.meals.map((m) => m.strCategory) : [];
    } catch (e) {
      console.error("Failed to load categories for fetching all meals", e);
      resultsDiv.textContent = "Failed to load recipes.";
      return [];
    }
  }

  try {
    const promises = categoriesList.map((cat) =>
      fetch(
        `https://www.themealdb.com/api/json/v1/1/filter.php?c=${encodeURIComponent(
          cat
        )}`
      )
        .then((r) => r.json())
        .then((d) => d.meals || [])
        .catch((e) => {
          console.warn("Failed fetch for category", cat, e);
          return [];
        })
    );

    const perCategory = await Promise.all(promises);
    // flatten and dedupe by idMeal
    const combined = [];
    const seen = new Set();
    perCategory.flat().forEach((meal) => {
      if (!meal || !meal.idMeal) return;
      if (!seen.has(meal.idMeal)) {
        seen.add(meal.idMeal);
        combined.push(meal);
      }
    });

    return combined;
  } catch (err) {
    console.error("Error fetching all meals:", err);
    resultsDiv.textContent = "Failed to load recipes.";
    return [];
  }
}

// Fetch full meal detail for a single id
async function fetchMealDetail(id) {
  try {
    const res = await fetch(
      `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(
        id
      )}`
    );
    const data = await res.json();
    return data.meals && data.meals[0] ? data.meals[0] : null;
  } catch (e) {
    console.warn("Failed to fetch detail for", id, e);
    return null;
  }
}

// Fetch details for many ids and return array of full meals
async function fetchDetailsForMeals(meals) {
  const ids = meals.map((m) => m.idMeal).filter(Boolean);
  const promises = ids.map((id) => fetchMealDetail(id));
  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

// Apply current filters (area, category, favorites) and render with pagination
async function applyFilters() {
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "Loading...";

  let meals = [];

  // If search is active, perform search first and then apply other filters
  if (state.search) {
    try {
      const res = await fetch(
        `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(
          state.search
        )}`
      );
      const data = await res.json();
      const found = data.meals || [];
      // Map to minimal shape used elsewhere
      meals = found.map((m) => ({
        idMeal: m.idMeal,
        strMeal: m.strMeal,
        strMealThumb: m.strMealThumb,
        // Also keep full details for filtering by area/category
        _full: m,
      }));
      // Apply area/category/favorites filters to search results
      if (state.favoritesOnly) {
        const favMap = getFavoritesMap();
        meals = meals.filter((m) => favMap[m.idMeal]);
      }
      if (state.area) {
        meals = meals.filter((m) =>
          m._full ? m._full.strArea === state.area : true
        );
      }
      if (state.category && state.category !== "all") {
        meals = meals.filter((m) =>
          m._full ? m._full.strCategory === state.category : true
        );
      }
      // strip _full before paginating
      meals = meals.map((m) => ({
        idMeal: m.idMeal,
        strMeal: m.strMeal,
        strMealThumb: m.strMealThumb,
      }));
      paginateAndRender(meals);
      return;
    } catch (e) {
      console.error("Search failed:", e);
      resultsDiv.textContent = "Search failed.";
      return;
    }
  }

  // If favorites-only, start with favorite items (may be minimal data)
  if (state.favoritesOnly) {
    const favMap = getFavoritesMap();
    const favArray = Object.values(favMap);
    if (favArray.length === 0) {
      resultsDiv.textContent =
        "No favorites yet. Click the star on a recipe to save it.";
      renderPagination(0);
      return;
    }

    // If no extra filters, just use favorites (they only contain id, title, thumb)
    if (!state.area && (!state.category || state.category === "all")) {
      meals = favArray;
    } else {
      // need to fetch details for each favorite and filter
      const fullFavs = await fetchDetailsForMeals(favArray);
      meals = fullFavs
        .filter((m) => {
          if (state.area && m.strArea !== state.area) return false;
          if (
            state.category &&
            state.category !== "all" &&
            m.strCategory !== state.category
          )
            return false;
          return true;
        })
        .map((m) => ({
          idMeal: m.idMeal,
          strMeal: m.strMeal,
          strMealThumb: m.strMealThumb,
        }));
    }
    paginateAndRender(meals);
    return;
  }

  // Not favorites-only: combine area/category logic
  try {
    if (state.category === "all") {
      if (state.area) {
        // fetch by area
        const res = await fetch(
          `https://www.themealdb.com/api/json/v1/1/filter.php?a=${encodeURIComponent(
            state.area
          )}`
        );
        const data = await res.json();
        meals = data.meals || [];
      } else {
        // all categories & no area -> get all meals
        meals = await getAllMeals();
      }
    } else {
      // category specified
      const res = await fetch(
        `https://www.themealdb.com/api/json/v1/1/filter.php?c=${encodeURIComponent(
          state.category
        )}`
      );
      const data = await res.json();
      meals = data.meals || [];

      // if area is also specified, we need to filter by area using detail lookups
      if (state.area) {
        const fulls = await fetchDetailsForMeals(meals);
        meals = fulls
          .filter((m) => m.strArea === state.area)
          .map((m) => ({
            idMeal: m.idMeal,
            strMeal: m.strMeal,
            strMealThumb: m.strMealThumb,
          }));
      }
    }
  } catch (e) {
    console.error("Error applying filters:", e);
    resultsDiv.textContent = "Failed to load recipes.";
    return;
  }

  paginateAndRender(meals);
}

// Paginate and render meals array using state.page and state.pageSize
function paginateAndRender(meals) {
  const total = meals.length;
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * pageSize;
  const slice = meals.slice(start, start + pageSize);
  if (slice.length === 0) {
    const resultsDiv = document.getElementById("results");
    resultsDiv.innerHTML = "No recipes found.";
  } else {
    renderMealCards(slice);
  }
  renderPagination(total);
}

// Update pagination UI
function renderPagination(totalItems) {
  const pageInfo = document.getElementById("page-info");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");
  const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
  pageInfo.textContent = `Page ${state.page} of ${totalPages}`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = state.page >= totalPages;
}

// Attach handlers after DOM ready
function attachPaginationHandlers() {
  const prev = document.getElementById("prev-page");
  const next = document.getElementById("next-page");
  if (prev && next) {
    prev.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        applyFilters();
      }
    });
    next.addEventListener("click", () => {
      state.page += 1;
      applyFilters();
    });
  }
}

// Render small meal cards and attach click handlers to fetch details
function renderMealCards(meals) {
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "";

  meals.forEach((meal) => {
    const mealDiv = document.createElement("div");
    mealDiv.className = "meal";
    // store id for lookup
    mealDiv.dataset.id = meal.idMeal;

    const title = document.createElement("h3");
    title.textContent = meal.strMeal;

    const img = document.createElement("img");
    img.src = meal.strMealThumb;
    img.alt = meal.strMeal;

    // Favorite button
    const favBtn = document.createElement("button");
    favBtn.className = "fav-btn";
    favBtn.type = "button";
    favBtn.title = "Toggle favorite";
    favBtn.innerHTML = isFavorited(meal.idMeal) ? "★" : "☆";
    if (isFavorited(meal.idMeal)) favBtn.classList.add("active");

    // Clicking the favorite button toggles favorites and doesn't open details
    favBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleFavorite(meal);
      const nowFav = isFavorited(meal.idMeal);
      favBtn.innerHTML = nowFav ? "★" : "☆";
      favBtn.classList.toggle("active", nowFav);
    });

    mealDiv.appendChild(favBtn);
    mealDiv.appendChild(title);
    mealDiv.appendChild(img);
    resultsDiv.appendChild(mealDiv);

    // clicking a card fetches details, logs to console, and renders on page
    mealDiv.addEventListener("click", async () => {
      const id = mealDiv.dataset.id;
      if (!id) return;
      try {
        const res = await fetch(
          `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(
            id
          )}`
        );
        const data = await res.json();
        if (data.meals && data.meals.length > 0) {
          const fullMeal = data.meals[0];
          // Log full recipe to console (as requested)
          console.log("Full recipe details:", fullMeal);
          // Render details to the page
          renderMealDetails(fullMeal);
        } else {
          console.warn("No details found for meal id:", id);
        }
      } catch (err) {
        console.error("Error fetching meal details:", err);
      }
    });
  });
}

// Build and show the detailed recipe view
function renderMealDetails(meal) {
  const detailsDiv = document.getElementById("details");
  detailsDiv.innerHTML = "";

  const container = document.createElement("div");
  container.className = "recipe-details";

  const img = document.createElement("img");
  img.src = meal.strMealThumb;
  img.alt = meal.strMeal;

  const meta = document.createElement("div");
  meta.className = "recipe-meta";

  const title = document.createElement("h2");
  title.textContent = meal.strMeal;

  // Ingredients: combine measures and ingredients
  const ingredients = parseIngredients(meal);
  const ingTitle = document.createElement("h4");
  ingTitle.textContent = "Ingredients";
  const ul = document.createElement("ul");
  ul.className = "ingredients";
  ingredients.forEach((ing) => {
    const li = document.createElement("li");
    li.textContent = ing;
    ul.appendChild(li);
  });

  const instrTitle = document.createElement("h4");
  instrTitle.textContent = "Instructions";
  const p = document.createElement("p");
  p.className = "instructions";
  p.textContent = meal.strInstructions || "";

  meta.appendChild(title);
  meta.appendChild(ingTitle);
  meta.appendChild(ul);
  meta.appendChild(instrTitle);
  meta.appendChild(p);

  container.appendChild(img);
  container.appendChild(meta);
  detailsDiv.appendChild(container);

  // Smooth scroll into view for the details
  detailsDiv.scrollIntoView({ behavior: "smooth" });
}

// Utility to extract ingredients/measures
function parseIngredients(meal) {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const ingredient = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (ingredient && ingredient.trim()) {
      const text =
        measure && measure.trim()
          ? `${measure.trim()} ${ingredient.trim()}`
          : ingredient.trim();
      list.push(text);
    }
  }
  return list;
}
