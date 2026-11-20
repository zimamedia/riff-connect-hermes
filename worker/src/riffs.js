// Made by scripts/sync-riffs.mjs from the Riff extension's lib/board/riffs.js. Do not edit by hand.
// The inbox uses this to tell an agent which cards it can ask for. Riff checks every request again itself.

export const PROTOCOL = 1;

export const RIFFS = [
  {
    "id": "search-x",
    "name": "Search X for posts",
    "summary": "Your agent finds posts on X about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "search-linkedin",
    "name": "Search LinkedIn for posts",
    "summary": "Your agent finds posts on LinkedIn about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "where",
        "label": "Where to look",
        "required": false,
        "options": [
          {
            "value": "general",
            "label": "General posts"
          },
          {
            "value": "groups",
            "label": "Groups you name below"
          }
        ]
      },
      {
        "id": "groups",
        "label": "Groups (names or links)",
        "required": false,
        "max": 600
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "search-facebook",
    "name": "Search Facebook for posts",
    "summary": "Your agent finds posts on Facebook about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "where",
        "label": "Where to look",
        "required": false,
        "options": [
          {
            "value": "general",
            "label": "General posts"
          },
          {
            "value": "groups",
            "label": "Groups you name below"
          }
        ]
      },
      {
        "id": "groups",
        "label": "Groups (names or links)",
        "required": false,
        "max": 600
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "search-instagram",
    "name": "Search Instagram for posts",
    "summary": "Your agent finds posts on Instagram about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "search-threads",
    "name": "Search Threads for posts",
    "summary": "Your agent finds posts on Threads about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "search-youtube",
    "name": "Search YouTube for posts",
    "summary": "Your agent finds posts on YouTube about your keywords and saves the links. It only reads.",
    "unit": "saved posts",
    "goal": {
      "default": 10,
      "min": 1,
      "max": 50
    },
    "fields": [
      {
        "id": "topics",
        "label": "Keywords or topics",
        "required": true,
        "max": 300
      },
      {
        "id": "who",
        "label": "Only from (optional)",
        "required": false,
        "max": 200
      },
      {
        "id": "window",
        "label": "How recent",
        "required": false,
        "options": [
          {
            "value": "day",
            "label": "Last 24 hours"
          },
          {
            "value": "week",
            "label": "Last 7 days"
          },
          {
            "value": "month",
            "label": "Last 30 days"
          },
          {
            "value": "any",
            "label": "Any time"
          }
        ]
      },
      {
        "id": "lang",
        "label": "Language (optional)",
        "required": false,
        "max": 40
      }
    ]
  },
  {
    "id": "count-it-yourself",
    "name": "Count it yourself",
    "summary": "A card with no agent. You do the work and tick it off; the counter keeps the tally.",
    "unit": "done",
    "goal": {
      "default": 5,
      "min": 1,
      "max": 500
    },
    "fields": [
      {
        "id": "what",
        "label": "What you are counting",
        "required": true,
        "max": 120
      }
    ]
  }
];
