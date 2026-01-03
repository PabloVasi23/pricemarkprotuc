
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { FileUpload } from './components/FileUpload';
import { ResultsTable } from './components/ResultsTable';
import { SavedListsView } from './components/SavedListsView';
import { extractPricesFromImage, extractPricesFromUrl, cleanMessyDataWithAI } from './services/geminiService';
import { dbService, generateId } from './services/dbService';
import { ProductItem, AppState, RoundingRule, ProcessedProductItem, AppSettings, PricingTier, ProductSource, ImportSummary, SavedList } from './types';
import { 
  Calculator, 
  Plus, 
  Trash2, 
  Search, 
  FileText, 
  Globe,
  Upload as UploadIcon,
  LayoutDashboard,
  Download,
  Save,
  History,
  ClipboardCheck,
  Moon,
  Sun,
  Zap,
  Settings2,
  ExternalLink
} from 'lucide-react';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [savedLists, setSavedLists] = useState<SavedList[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  // State to store web search grounding sources
  const [sources, setSources] = useState<{ uri: string; title: string }[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark' || 
      (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  const fileImportRef = useRef<HTMLInputElement>(null);

  const [settings, setSettings] = useState<AppSettings>({
    businessName: '',
    exchangeRate: 1, 
    roundingRule: 'none',
    globalCurrency: 'auto',
    activeTier: 'tier3',
    markups: { tier1: 10, tier2: 20, tier3: 30, tier4: 50, tier5: 100, custom: 15 },
    clientAdjustment: 15,
    visibility: {
      baseCost: true,
      sellerPrice: true,
      suggestedPrice: true
    }
  });

  useEffect(() => {
    const savedSettings = localStorage.getItem('priceMarkupSettings');
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings));
    }
    loadData();
    
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleDarkMode = () => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  const loadData = useCallback(() => {
    const master = dbService.getMasterProducts();
    const lists = dbService.getSavedLists();
    setProducts(master);
    setSavedLists(lists);
  }, []);

  const handleSaveConfig = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem('priceMarkupSettings', JSON.stringify(newSettings));
  };

  const setViewPreset = (preset: 'internal' | 'reseller' | 'client') => {
    let visibility = { baseCost: true, sellerPrice: true, suggestedPrice: true };
    if (preset === 'reseller') visibility = { baseCost: false, sellerPrice: true, suggestedPrice: true };
    if (preset === 'client') visibility = { baseCost: false, sellerPrice: false, suggestedPrice: true };
    handleSaveConfig({ ...settings, visibility });
  };

  const processImportedData = (newItems: Omit<ProductItem, 'id' | 'source' | 'lastUpdated'>[], source: ProductSource) => {
    const itemsWithMeta = newItems.map(item => ({
      ...item,
      source,
      lastUpdated: new Date().toISOString()
    }));
    const result = dbService.upsertProducts(itemsWithMeta as any);
    setProducts(result.updatedMaster);
    setImportSummary(result.summary);
    setAppState(AppState.DATABASE);
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAppState(AppState.ANALYZING);
    // Clear previous sources on new import
    setSources([]);

    const reader = new FileReader();
    const ext = file.name.split('.').pop()?.toLowerCase();
    const isCsv = ext === 'csv' || ext === 'tsv' || ext === 'txt';

    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { 
          type: isCsv ? 'string' : 'binary', 
          cellNF: true, 
          cellText: true 
        });

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
        if (rows.length === 0) throw new Error("Archivo vacío");

        const messySample = rows.slice(0, 20);
        let messyColumnIdx = -1;
        
        for (let col = 0; col < (messySample[0]?.length || 0); col++) {
          const matchingRows = messySample.filter(row => {
            const cell = String(row[col] || "");
            return cell.includes('$') && cell.length > 10;
          });
          if (matchingRows.length > messySample.length * 0.4) {
            messyColumnIdx = col;
            break;
          }
        }

        if (messyColumnIdx !== -1) {
          const textBlock = rows.map(r => String(r[messyColumnIdx] || "")).filter(t => t.length > 5).join("\n");
          try {
            const aiResult = await cleanMessyDataWithAI(textBlock.substring(0, 8000));
            processImportedData(aiResult.items, 'csv');
            return;
          } catch (aiErr) {
            console.error("AI Error:", aiErr);
          }
        }

        const nameKws = ['nombre', 'producto', 'item', 'descripcion', 'articulo', 'description', 'detalle', 'title', 'label', 'name'];
        const priceKws = ['precio', 'costo', 'cost', 'unit', 'venta', 'p.u', 'valor', 'monto', 'final', 'lista', 'rate', 'amount', 'unitario'];
        
        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(20, rows.length); i++) {
          const rowStr = rows[i].map(c => String(c).toLowerCase());
          const hasName = rowStr.some(c => nameKws.some(k => c.includes(k)));
          const hasPrice = rowStr.some(c => priceKws.some(k => c.includes(k)));
          if (hasName && hasPrice) {
            headerRowIdx = i;
            break;
          }
        }

        const jsonData = XLSX.utils.sheet_to_json(sheet, { 
          range: headerRowIdx >= 0 ? headerRowIdx : 0,
          defval: ''
        }) as any[];

        const items = jsonData.map((row: any) => {
          const keys = Object.keys(row);
          let name = ''; let brandDesc = ''; let price = 0;

          const nameKey = keys.find(k => nameKws.some(kw => k.toLowerCase().includes(kw) && !k.toLowerCase().includes('precio')));
          const priceKey = keys.find(k => priceKws.some(kw => k.toLowerCase().includes(kw)));
          const brandKey = keys.find(k => ['marca', 'brand', 'fabricante', 'cod', 'sku'].some(kw => k.toLowerCase().includes(kw)) && k !== nameKey && k !== priceKey);

          if (nameKey && priceKey) {
            name = String(row[nameKey]);
            price = parseFloat(String(row[priceKey]).replace(/[^0-9.,]/g, '').replace('.', '').replace(',', '.')) || 0;
            brandDesc = brandKey ? String(row[brandKey]) : '';
          } else {
            name = String(row[keys[0]] || '');
            const potentialPrice = String(row[keys[1]] || '').replace(/[^0-9.,]/g, '').replace('.', '').replace(',', '.');
            price = parseFloat(potentialPrice) || 0;
          }
          
          return { 
            name: name.trim(), 
            brand: brandDesc.trim(), 
            originalPrice: price, 
            currency: '$' 
          };
        }).filter(i => i.name.length > 1 && i.originalPrice > 0);

        if (items.length > 0) {
          processImportedData(items, isCsv ? 'csv' : 'excel');
        } else {
          setAppState(AppState.IDLE);
          alert("No se detectaron productos válidos.");
        }
      } catch (err) {
        setAppState(AppState.IDLE);
        alert("Error al procesar el archivo.");
      }
    };

    if (isCsv) {
      reader.readAsText(file, 'UTF-8');
    } else {
      reader.readAsBinaryString(file);
    }
    e.target.value = '';
  };

  const processedItems: ProcessedProductItem[] = useMemo(() => {
    const sellerMarkup = settings.markups[settings.activeTier];
    const clientMarkup = settings.clientAdjustment;
    const filtered = products.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.brand.toLowerCase().includes(searchTerm.toLowerCase()));
    return filtered.map(product => {
      const baseCostLocal = product.originalPrice * settings.exchangeRate;
      let sellerPrice = baseCostLocal * (1 + sellerMarkup / 100);
      let suggestedPrice = sellerPrice * (1 + clientMarkup / 100);
      const applyRounding = (val: number) => {
        if (settings.roundingRule === '99') return Math.floor(val) + 0.99;
        if (settings.roundingRule === '00') return Math.round(val);
        if (settings.roundingRule === '10') return Math.ceil(val / 10) * 10;
        if (settings.roundingRule === '100') return Math.ceil(val / 100) * 100;
        return val;
      };
      return {
        ...product,
        calculatedCostLocal: baseCostLocal,
        sellerPrice: applyRounding(sellerPrice),
        suggestedPrice: applyRounding(suggestedPrice),
        currency: settings.globalCurrency === 'auto' ? (product.currency || '$') : settings.globalCurrency
      };
    });
  }, [products, searchTerm, settings]);

  const generateLegibleText = () => {
    const header = `📦 *LISTA DE PRECIOS - ${new Date().toLocaleDateString()}*\n----------------------------------\n\n`;
    const body = processedItems.map(item => {
      let text = `🛍️ *${item.name.toUpperCase()}*\n`;
      if (item.brand) text += `🏷️ Marca: ${item.brand}\n`;
      if (settings.visibility.suggestedPrice) text += `💰 Precio: ${item.currency}${item.suggestedPrice.toLocaleString()}\n`;
      else if (settings.visibility.sellerPrice) text += `💰 Precio: ${item.currency}${item.sellerPrice.toLocaleString()}\n`;
      text += `----------------------------------`;
      return text;
    }).join('\n\n');
    return header + body;
  };

  const handleWhatsAppCopy = () => {
    const text = generateLegibleText();
    navigator.clipboard.writeText(text).then(() => {
      alert("¡Lista copiada!");
    }).catch(() => {
      alert("Error al copiar.");
    });
  };

  const handleDownloadTxt = () => {
    const text = generateLegibleText().replace(/\*/g, ''); 
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lista_precios_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSaveCurrentList = () => {
    if (products.length === 0) {
      alert("No hay productos para guardar.");
      return;
    }
    const name = prompt("Nombre para esta lista:", `Lista ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`);
    if (!name) return;
    
    const newList: SavedList = {
      id: generateId(),
      name,
      items: JSON.parse(JSON.stringify(products)),
      date: new Date().toISOString()
    };
    
    const updatedHistory = dbService.saveList(newList);
    setSavedLists(updatedHistory);
    alert("¡Lista guardada en el Historial con éxito!");
  };

  const handleClearView = () => {
    if (confirm("¿Limpiar la vista actual? Los cambios no guardados en el historial se perderán.")) {
      setProducts([]);
      setSources([]);
      dbService.saveMasterProducts([]);
      setImportSummary(null);
      setAppState(AppState.IDLE);
    }
  };

  const handleUrlImport = async () => {
    if (!urlInput) return;
    setAppState(AppState.ANALYZING);
    setSources([]);
    try {
      const result = await extractPricesFromUrl(urlInput);
      processImportedData(result.items, 'url');
      // Store grounding sources for display as required by guidelines
      setSources(result.sources || []);
      setUrlInput('');
    } catch (err) {
      setAppState(AppState.IDLE);
      alert("Error en extracción web.");
    }
  };

  const handleDeleteHistoryAll = () => {
    if (confirm("🚨 ¿BORRAR TODO EL HISTORIAL?")) {
      localStorage.removeItem('pm_saved_lists');
      setSavedLists([]);
    }
  };

  const handleDeleteProduct = useCallback((id: string) => {
    if(confirm("¿Estás seguro de eliminar este producto?")) {
      const updated = dbService.deleteProduct(id);
      setProducts(updated);
      if (updated.length === 0) {
        setAppState(AppState.IDLE);
        setSources([]);
      }
    }
  }, []);

  const handleUpdateProduct = useCallback((id: string, updates: Partial<ProductItem>) => {
    const updated = products.map(p => p.id === id ? { ...p, ...updates, lastUpdated: new Date().toISOString() } : p);
    setProducts(updated);
    dbService.saveMasterProducts(updated);
  }, [products]);

  const handleAddManualProduct = useCallback(() => {
    const newItem: ProductItem = { 
      id: generateId(), 
      name: "Nuevo Producto", 
      brand: "", 
      originalPrice: 0, 
      currency: "$", 
      source: 'manual', 
      lastUpdated: new Date().toISOString() 
    };
    const updated = [newItem, ...products];
    setProducts(updated);
    dbService.saveMasterProducts(updated);
  }, [products]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-slate-100 pb-20 font-inter transition-colors duration-300">
      <header className="bg-white dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-cyan-500/30 sticky top-0 z-40 shadow-xl">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setAppState(AppState.IDLE)}>
            <div className="bg-blue-600 dark:bg-cyan-500 p-2 rounded-lg text-white shadow-lg dark:neon-border-cyan">
              <Calculator size={20} />
            </div>
            <h1 className="font-black text-lg tracking-tighter uppercase dark:text-white dark:neon-text-cyan">
              PriceMarkup <span className="text-blue-500 dark:text-neonPink dark:neon-text-pink">PRO</span>
            </h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={toggleDarkMode} 
              className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-neonCyan border border-transparent dark:border-cyan-500/50 transition-all hover:scale-110 active:scale-95 shadow-inner"
              title={isDarkMode ? "Modo Luz" : "Modo Futuro"}
            >
              {isDarkMode ? <Sun size={20} className="animate-pulse" /> : <Moon size={20} />}
            </button>

            <button onClick={() => { loadData(); setAppState(AppState.SAVED_LISTS); }} className="p-2 text-slate-400 hover:text-slate-900 dark:hover:text-neonPink transition-colors flex items-center gap-2 group">
              <History size={20} className="group-hover:rotate-12 transition-transform"/><span className="hidden sm:inline text-[10px] font-black uppercase tracking-widest">Historial</span>
            </button>
            <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1"></div>
            <button 
              onClick={handleClearView} 
              className="p-2 bg-red-50 dark:bg-red-950/30 text-red-500 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 transition-all shadow-sm border border-transparent dark:border-red-500/20" 
              title="Borrar Inventario Actual"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {appState === AppState.SAVED_LISTS ? (
          <SavedListsView 
            lists={savedLists} 
            onRestore={(list) => { 
              setProducts(list.items); 
              dbService.saveMasterProducts(list.items);
              setAppState(AppState.DATABASE); 
            }}
            onDelete={(id) => { 
              const updated = dbService.deleteList(id); 
              setSavedLists(updated); 
            }}
            onDeleteAll={handleDeleteHistoryAll}
            onBack={() => setAppState(products.length > 0 ? AppState.DATABASE : AppState.IDLE)}
          />
        ) : (
          <>
            {importSummary && (
              <div className="mb-6 bg-emerald-600 dark:bg-neonLime text-white dark:text-slate-950 p-4 rounded-xl shadow-lg dark:neon-border-pink flex items-center justify-between animate-in slide-in-from-top-4">
                <p className="text-sm font-bold">Importación exitosa: {importSummary.added} nuevos, {importSummary.updated} actualizados.</p>
                <button onClick={() => setImportSummary(null)} className="text-white/50 hover:text-white"><Plus className="rotate-45" size={20}/></button>
              </div>
            )}

            {appState === AppState.IDLE && (
               <div className="max-w-4xl mx-auto py-12 space-y-12">
                  <div className="text-center space-y-4">
                    <h2 className="text-5xl md:text-6xl font-black text-slate-900 dark:text-white uppercase tracking-tighter leading-none">
                      Carga tus <span className="text-blue-600 dark:text-neonCyan dark:neon-text-cyan italic">Listas</span>
                    </h2>
                    {products.length > 0 && (
                      <button onClick={() => setAppState(AppState.DATABASE)} className="mt-4 inline-flex items-center gap-2 px-8 py-4 bg-slate-900 dark:bg-slate-800 text-white dark:text-neonCyan rounded-full font-black uppercase text-xs tracking-widest hover:bg-blue-600 dark:hover:bg-cyan-500 dark:hover:text-white shadow-xl dark:neon-border-cyan transition-all transform hover:-translate-y-1">
                        <LayoutDashboard size={18}/> Ver Inventario ({products.length})
                      </button>
                    )}
                  </div>
                  
                  <div className="grid md:grid-cols-2 gap-8">
                    <div onClick={() => fileImportRef.current?.click()} className="bg-white dark:bg-slate-900/50 backdrop-blur-sm p-10 rounded-[2.5rem] border-2 border-slate-100 dark:border-cyan-500/20 hover:border-blue-500 dark:hover:border-neonCyan transition-all cursor-pointer group shadow-sm dark:shadow-none relative overflow-hidden">
                      <div className="absolute top-0 right-0 p-4 opacity-5 dark:opacity-10"><FileText size={120} /></div>
                      <div className="w-16 h-16 bg-blue-50 dark:bg-cyan-950 rounded-2xl flex items-center justify-center text-blue-600 dark:text-neonCyan mb-6 group-hover:bg-blue-600 dark:group-hover:bg-neonCyan group-hover:text-white dark:group-hover:text-slate-950 transition-all shadow-inner"><FileText size={32}/></div>
                      <h3 className="text-2xl font-black uppercase mb-2 dark:text-white">Excel / CSV</h3>
                      <p className="text-slate-400 dark:text-slate-500 text-sm">Sube tus archivos de proveedores o datos scrapeados.</p>
                      <input type="file" ref={fileImportRef} onChange={handleFileImport} className="hidden" accept=".xlsx,.xls,.csv,.txt" />
                    </div>
                    
                    <div className="bg-white dark:bg-slate-900/50 backdrop-blur-sm p-10 rounded-[2.5rem] border-2 border-slate-100 dark:border-neonPink/20 hover:border-emerald-500 dark:hover:border-neonPink transition-all shadow-sm dark:shadow-none relative overflow-hidden group">
                      <div className="absolute top-0 right-0 p-4 opacity-5 dark:opacity-10"><UploadIcon size={120} /></div>
                      <div className="w-16 h-16 bg-emerald-50 dark:bg-pink-950 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-neonPink mb-6 group-hover:bg-pink-500 dark:group-hover:bg-neonPink group-hover:text-white dark:group-hover:text-slate-950 transition-all shadow-inner"><UploadIcon size={32}/></div>
                      <h3 className="text-2xl font-black uppercase mb-2 dark:text-white">Imágenes / IA</h3>
                      <FileUpload onFileSelect={async (file) => {
                        setAppState(AppState.ANALYZING);
                        setSources([]);
                        const reader = new FileReader();
                        reader.readAsDataURL(file);
                        reader.onload = async () => {
                          const base64 = (reader.result as string).split(',')[1];
                          try {
                            const result = await extractPricesFromImage(base64, file.type);
                            processImportedData(result.items, 'image');
                          } catch (err) { alert("Error IA: " + err); setAppState(AppState.IDLE); }
                        };
                      }} />
                    </div>
                  </div>

                  <div className="bg-slate-900 dark:bg-black/40 dark:backdrop-blur-xl dark:neon-border-cyan rounded-[3rem] p-12 text-white flex flex-col md:flex-row items-center gap-10 shadow-2xl relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50"></div>
                    <div className="flex-1 space-y-5">
                      <h3 className="text-3xl font-black uppercase tracking-tighter dark:neon-text-cyan">Extraer de URL</h3>
                      <div className="flex gap-2">
                        <input 
                          type="text" 
                          placeholder="Enlace de lista online..." 
                          className="flex-1 bg-white/10 dark:bg-white/5 border border-white/20 dark:border-cyan-500/30 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-neonCyan transition-all"
                          value={urlInput}
                          onChange={e => setUrlInput(e.target.value)}
                        />
                        <button onClick={handleUrlImport} className="bg-blue-600 dark:bg-neonCyan dark:text-slate-950 p-4 rounded-2xl hover:bg-blue-700 dark:hover:bg-white transition-all shadow-lg"><Globe/></button>
                      </div>
                    </div>
                    <div className="w-px h-24 bg-white/10 hidden md:block"></div>
                    <div className="flex-1 space-y-4 text-center md:text-left">
                      <h3 className="text-xl font-black uppercase tracking-tighter dark:text-slate-300">Carga Manual</h3>
                      <button onClick={() => {
                        const newItem: ProductItem = { id: generateId(), name: "Nuevo Producto", brand: "", originalPrice: 0, currency: "$", source: 'manual', lastUpdated: new Date().toISOString() };
                        setProducts([newItem, ...products]);
                        setSources([]);
                        dbService.saveMasterProducts([newItem, ...products]);
                        setAppState(AppState.DATABASE);
                      }} className="px-8 py-4 bg-slate-800 dark:bg-slate-700 text-white dark:text-neonPink rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-slate-700 dark:hover:bg-neonPink dark:hover:text-white transition-all">Empezar de cero</button>
                    </div>
                  </div>
               </div>
            )}

            {appState === AppState.ANALYZING && (
              <div className="flex flex-col items-center justify-center py-40 gap-8">
                <div className="relative">
                  <div className="w-32 h-32 border-8 border-blue-600/10 dark:border-cyan-500/10 border-t-blue-600 dark:border-t-neonCyan rounded-full animate-spin"></div>
                  <Zap className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-600 dark:text-neonCyan animate-pulse" size={32} />
                </div>
                <div className="text-center space-y-2">
                  <p className="font-black uppercase tracking-[0.3em] text-slate-900 dark:text-neonCyan dark:neon-text-cyan">Analizando Redes...</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 uppercase font-bold tracking-widest">Sincronizando con el motor de IA</p>
                </div>
              </div>
            )}

            {(appState === AppState.DATABASE || appState === AppState.RESULTS) && (
              <div className="grid lg:grid-cols-12 gap-8">
                <aside className="lg:col-span-3 space-y-6">
                  <div className="bg-white dark:bg-slate-900/50 backdrop-blur-md rounded-[2.5rem] p-8 border border-slate-200 dark:border-cyan-500/20 shadow-sm space-y-8">
                    <button onClick={() => setAppState(AppState.IDLE)} className="w-full flex items-center justify-center gap-3 p-5 border-2 border-dashed border-blue-200 dark:border-cyan-500/30 text-blue-600 dark:text-neonCyan rounded-3xl hover:bg-blue-50 dark:hover:bg-cyan-500/10 font-black uppercase text-[10px] tracking-widest transition-all"><Plus size={18}/> Sumar más productos</button>
                    
                    <div className="relative">
                      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-neonCyan/50" size={18}/>
                      <input type="text" placeholder="BUSCAR..." className="w-full pl-12 pr-5 py-4 bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-cyan-500/20 rounded-2xl text-xs font-black outline-none focus:border-blue-500 dark:focus:border-neonCyan transition-all dark:text-white" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}/>
                    </div>

                    <div className="space-y-5 pt-6 border-t border-slate-100 dark:border-slate-800">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-600 tracking-widest">Margen Vendedor</label>
                        <Settings2 size={14} className="text-slate-300 dark:text-slate-700" />
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        {Object.keys(settings.markups).filter(k => k !== 'custom').map((t) => (
                          <button key={t} onClick={() => handleSaveConfig({...settings, activeTier: t as PricingTier})} className={`py-4 rounded-2xl border text-[11px] font-black transition-all transform active:scale-95 ${settings.activeTier === t ? 'bg-blue-600 dark:bg-neonCyan text-white dark:text-slate-950 border-blue-700 dark:border-cyan-400 shadow-lg dark:neon-border-cyan' : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-slate-700'}`}>+{settings.markups[t as PricingTier]}%</button>
                        ))}
                      </div>

                      <div className="relative mt-2">
                        <div className={`absolute -top-2 left-4 px-2 text-[9px] font-black uppercase transition-colors ${settings.activeTier === 'custom' ? 'text-blue-600 dark:text-neonCyan' : 'text-slate-400'}`}>Exacto (%)</div>
                        <input 
                          type="number"
                          value={settings.markups.custom}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            handleSaveConfig({
                              ...settings,
                              activeTier: 'custom',
                              markups: { ...settings.markups, custom: val }
                            });
                          }}
                          className={`w-full bg-slate-50 dark:bg-black/20 border-2 rounded-2xl px-4 py-4 text-sm font-black outline-none transition-all dark:text-white ${settings.activeTier === 'custom' ? 'border-blue-500 dark:border-neonCyan dark:neon-border-cyan' : 'border-slate-100 dark:border-slate-800 focus:border-blue-300 dark:focus:border-cyan-900'}`}
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 font-black text-slate-300 dark:text-slate-700">%</div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <button onClick={handleWhatsAppCopy} className="w-full flex items-center justify-center gap-3 p-5 bg-emerald-600 dark:bg-neonLime text-white dark:text-slate-950 rounded-[1.5rem] shadow-lg hover:brightness-110 transition-all font-black uppercase text-xs tracking-widest dark:neon-border-pink">
                      <ClipboardCheck size={20} /> WhatsApp
                    </button>
                    <button onClick={handleDownloadTxt} className="w-full flex items-center justify-center gap-3 p-5 bg-slate-900 dark:bg-slate-800 text-white dark:text-neonCyan rounded-[1.5rem] shadow-lg hover:bg-slate-800 dark:hover:bg-slate-700 transition-all font-black uppercase text-xs tracking-widest border border-transparent dark:border-cyan-500/30">
                      <Download size={20} /> Descargar .TXT
                    </button>
                    <button onClick={handleSaveCurrentList} className="w-full flex items-center justify-center gap-3 p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-pink-500/20 text-slate-600 dark:text-neonPink rounded-[1.5rem] hover:bg-blue-50 dark:hover:bg-pink-500/10 hover:text-blue-600 transition-all font-black uppercase text-xs tracking-widest">
                      <Save size={20} /> Guardar Historial
                    </button>
                  </div>
                  
                  <div className="bg-slate-900 dark:bg-black/60 rounded-[2.5rem] p-8 text-white space-y-6 shadow-xl border border-transparent dark:border-cyan-500/20">
                    <div className="flex justify-between items-center"><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Tasa Cambio</span><input type="number" step="0.1" value={settings.exchangeRate} onChange={e => handleSaveConfig({...settings, exchangeRate: parseFloat(e.target.value) || 1})} className="w-24 bg-white/10 dark:bg-cyan-500/10 border border-white/20 dark:border-cyan-500/30 rounded-xl px-3 py-2 text-right text-sm font-black outline-none focus:border-blue-500 dark:focus:border-neonCyan dark:text-neonCyan"/></div>
                    <div className="flex justify-between items-center"><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Redondeo</span><select value={settings.roundingRule} onChange={e => handleSaveConfig({...settings, roundingRule: e.target.value as RoundingRule})} className="bg-white/10 dark:bg-cyan-500/10 border border-white/20 dark:border-cyan-500/30 rounded-xl text-xs font-black p-2 outline-none dark:text-neonCyan"><option value="none">Normal</option><option value="99">.99</option><option value="00">.00</option><option value="10">x10</option><option value="100">x100</option></select></div>
                  </div>
                </aside>

                <div className="lg:col-span-9 space-y-6">
                  <div className="flex bg-white dark:bg-slate-900/50 backdrop-blur-md rounded-2xl p-1.5 border border-slate-200 dark:border-cyan-500/20 mb-6 w-fit ml-auto shadow-sm">
                    <button onClick={() => setViewPreset('internal')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${settings.visibility.baseCost ? 'bg-slate-900 dark:bg-cyan-500 text-white dark:text-slate-950 shadow-md' : 'text-slate-400 dark:text-slate-600'}`}>Interno</button>
                    <button onClick={() => setViewPreset('reseller')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!settings.visibility.baseCost && settings.visibility.sellerPrice ? 'bg-slate-900 dark:bg-cyan-500 text-white dark:text-slate-950 shadow-md' : 'text-slate-400 dark:text-slate-600'}`}>Reventa</button>
                    <button onClick={() => setViewPreset('client')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!settings.visibility.sellerPrice ? 'bg-slate-900 dark:bg-cyan-500 text-white dark:text-slate-950 shadow-md' : 'text-slate-400 dark:text-slate-600'}`}>Cliente</button>
                  </div>
                  
                  <ResultsTable 
                    items={processedItems}
                    currencySymbol={settings.globalCurrency === 'auto' ? '$' : settings.globalCurrency}
                    visibility={settings.visibility}
                    onToggleVisibility={(col) => handleSaveConfig({...settings, visibility: {...settings.visibility, [col]: !settings.visibility[col as keyof typeof settings.visibility]}})}
                    onUpdate={handleUpdateProduct}
                    onDelete={handleDeleteProduct}
                    onAdd={handleAddManualProduct}
                  />

                  {/* Display information sources extracted via web search grounding */}
                  {sources.length > 0 && (
                    <div className="bg-white dark:bg-slate-900/40 backdrop-blur-md rounded-[2rem] p-8 border border-slate-200 dark:border-cyan-500/20 shadow-lg animate-in fade-in slide-in-from-bottom-4">
                      <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500 mb-4 flex items-center gap-2">
                        <Globe size={14}/> Fuentes de Información
                      </h4>
                      <div className="flex flex-wrap gap-3">
                        {sources.map((src, idx) => (
                          <a 
                            key={idx} 
                            href={src.uri} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 px-4 py-2 bg-slate-50 dark:bg-cyan-500/10 text-blue-600 dark:text-neonCyan rounded-xl text-[11px] font-bold hover:bg-blue-600 dark:hover:bg-neonCyan hover:text-white dark:hover:text-slate-950 transition-all border border-transparent dark:border-cyan-500/20 shadow-sm"
                          >
                            <span className="truncate max-w-[200px] text-xs">{src.title}</span>
                            <ExternalLink size={12}/>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default App;
