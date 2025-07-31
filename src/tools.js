export const tools = [
  {
    name: 'brave_scrape',
    description: 'Weboldal tartalmának scrape-elése Brave böngészővel',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'A scrape-elendő URL'
        },
        waitForSelector: {
          type: 'string',
          description: 'CSS selector amire várni kell'
        },
        waitTime: {
          type: 'number',
          description: 'Várakozási idő milliszekundumban'
        },
        screenshot: {
          type: 'boolean',
          description: 'Screenshot készítése'
        },
        includeHtml: {
          type: 'boolean',
          description: 'Teljes HTML tartalom visszaadása'
        }
      },
      required: ['url']
    },
    execute: async (controller, params) => {
      return await controller.scrape(params.url, params);
    }
  },

  {
    name: 'brave_crawl',
    description: 'Weboldal crawl-olása (több oldal bejárása)',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        startUrl: {
          type: 'string',
          description: 'Kezdő URL'
        },
        maxPages: {
          type: 'number',
          description: 'Maximum oldalszám (alapértelmezett: 10)'
        },
        sameDomain: {
          type: 'boolean',
          description: 'Csak ugyanazon domain (alapértelmezett: true)'
        },
        includePattern: {
          type: 'string',
          description: 'Regex pattern a befogadandó URL-ekhez'
        },
        excludePattern: {
          type: 'string',
          description: 'Regex pattern a kizárandó URL-ekhez'
        }
      },
      required: ['startUrl']
    },
    execute: async (controller, params) => {
      return await controller.crawl(params.startUrl, params);
    }
  },

  {
    name: 'brave_search',
    description: 'Keresés a Brave search-ben',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keresési kifejezés'
        },
        limit: {
          type: 'number',
          description: 'Eredmények száma (alapértelmezett: 10)'
        }
      },
      required: ['query']
    },
    execute: async (controller, params) => {
      return await controller.search(params.query, params);
    }
  },

  {
    name: 'brave_login',
    description: 'Bejelentkezés weboldalakra (Gmail, Facebook, Twitter, stb.)',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          enum: ['gmail', 'facebook', 'twitter', 'linkedin', 'instagram', 'custom'],
          description: 'Weboldal típusa'
        },
        customUrl: {
          type: 'string',
          description: 'Egyedi URL ha site="custom"'
        },
        credentials: {
          type: 'object',
          properties: {
            username: {
              type: 'string',
              description: 'Email vagy felhasználónév'
            },
            password: {
              type: 'string',
              description: 'Jelszó'
            },
            totp: {
              type: 'string',
              description: '2FA kód (opcionális)'
            }
          },
          required: ['username', 'password']
        },
        saveSession: {
          type: 'boolean',
          description: 'Session mentése későbbi használatra',
          default: true
        }
      },
      required: ['site', 'credentials']
    },
    execute: async (controller, params) => {
      return await controller.login(params);
    }
  },

  {
    name: 'brave_session_action',
    description: 'Művelet végrehajtása bejelentkezett session-nel',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          description: 'Melyik oldalon (pl: gmail, facebook)'
        },
        action: {
          type: 'string',
          enum: ['read_emails', 'send_email', 'get_messages', 'post_content', 'download_data', 'export_contacts', 'backup_photos', 'custom'],
          description: 'Végrehajtandó művelet'
        },
        customScript: {
          type: 'string',
          description: 'Egyedi JavaScript ha action="custom"'
        },
        parameters: {
          type: 'object',
          description: 'Művelet paraméterei'
        }
      },
      required: ['site', 'action']
    },
    execute: async (controller, params) => {
      return await controller.executeSessionAction(params);
    }
  },

  {
    name: 'brave_list_sessions',
    description: 'Aktív session-ök listázása',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    execute: async (controller, params) => {
      return await controller.listSessions();
    }
  },

  {
    name: 'brave_clear_sessions',
    description: 'Session-ök törlése',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          description: 'Melyik site session-jét töröljük (vagy "all" az összeshez)'
        }
      },
      required: ['site']
    },
    execute: async (controller, params) => {
      return await controller.clearSessions(params.site);
    }
  },

  {
    name: 'brave_visual_captcha',
    description: 'CAPTCHA vizuális kezelése screenshot alapján',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['capture', 'click', 'type'],
          description: 'Művelet típusa'
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' }
          },
          description: 'Kattintási koordináták'
        },
        text: {
          type: 'string',
          description: 'Beírandó szöveg'
        }
      },
      required: ['action']
    },
    execute: async (controller, params) => {
      return await controller.visualCaptcha(params);
    }
  },

  {
    name: 'brave_mouse_control',
    description: 'Teljes egér kontroll - mozgatás, kattintás, húzás',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'doubleClick', 'rightClick', 'drag', 'hover', 'screenshot_with_cursor'],
          description: 'Egér művelet'
        },
        x: { type: 'number', description: 'X koordináta' },
        y: { type: 'number', description: 'Y koordináta' },
        targetX: { type: 'number', description: 'Cél X (drag esetén)' },
        targetY: { type: 'number', description: 'Cél Y (drag esetén)' },
        duration: { type: 'number', description: 'Művelet időtartama ms-ban' }
      },
      required: ['action']
    },
    execute: async (controller, params) => {
      return await controller.mouseControl(params);
    }
  },

  {
    name: 'brave_visual_inspect',
    description: 'Vizuális elem felismerés és interakció',
    handler: 'tools/call',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['full_analysis', 'find_element', 'interactive_map'],
          description: 'Vizsgálat módja'
        },
        query: {
          type: 'string',
          description: 'Mit keresünk? (pl: "piros gomb", "bejelentkezés")'
        }
      },
      required: ['mode']
    },
    execute: async (controller, params) => {
      return await controller.visualInspect(params);
    }
  }
];