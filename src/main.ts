import {
    addIcon,
    Notice,
    Editor,
    FileView,
    MarkdownView,
    MenuItem,
    Menu,
    TFile,
    Plugin,
    WorkspaceLeaf,
    TAbstractFile,
} from 'obsidian';
import * as consts from 'src/consts';
import * as leaflet from 'leaflet';
import { LocationSuggest } from 'src/geosearch';
import { UrlConvertor } from 'src/urlConvertor';

import { MapView } from 'src/mapView';
import {
    PluginSettings,
    DEFAULT_SETTINGS,
    convertLegacyMarkerIcons,
    convertLegacyTilesUrl,
    convertLegacyDefaultState,
    removeLegacyPresets1,
    MapState,
} from 'src/settings';
import {
    getFrontMatterLocation,
    matchInlineLocation,
    verifyLocation,
} from 'src/markers';
import { SettingsTab } from 'src/settingsTab';
import { NewNoteDialog } from 'src/newNoteDialog';
import * as utils from 'src/utils';

export default class MapViewPlugin extends Plugin {
    settings: PluginSettings;
    public highestVersionSeen: number = 0;
    private suggestor: LocationSuggest;
    private urlConvertor: UrlConvertor;

    async onload() {
        addIcon('globe', consts.RIBBON_ICON);

        await this.loadSettings();

        // Add a new ribbon entry to the left bar
        this.addRibbonIcon('globe', 'Open map view', () => {
            // When clicked change the active view to the map
            this.app.workspace
                .getLeaf()
                .setViewState({ type: consts.MAP_VIEW_NAME });
        });

        this.registerView(consts.MAP_VIEW_NAME, (leaf: WorkspaceLeaf) => {
            return new MapView(leaf, this.settings, this);
        });

        this.suggestor = new LocationSuggest(this.app, this.settings);
        this.urlConvertor = new UrlConvertor(this.app, this.settings);

        this.registerEditorSuggest(this.suggestor);

        // Convert old settings formats that are no longer supported
        if (convertLegacyMarkerIcons(this.settings)) {
            await this.saveSettings();
            new Notice(
                'Map View: legacy marker icons were converted to the new format'
            );
        }
        if (convertLegacyTilesUrl(this.settings)) {
            await this.saveSettings();
            new Notice(
                'Map View: legacy tiles URL was converted to the new format'
            );
        }
        if (convertLegacyDefaultState(this.settings)) {
            await this.saveSettings();
            new Notice(
                'Map View: legacy default state was converted to the new format'
            );
        }
        if (removeLegacyPresets1(this.settings)) {
            await this.saveSettings();
            new Notice(
                'Map View: legacy URL parsing rules and/or map sources were converted. See the release notes'
            );
        }

        // Register commands to the command palette
        // Command that opens the map view (same as clicking the map icon)
        this.addCommand({
            id: 'open-map-view',
            name: 'Open Map View',
            callback: () => {
                this.app.workspace
                    .getLeaf()
                    .setViewState({ type: consts.MAP_VIEW_NAME });
            },
        });

        // Command that looks up the selected text to find the location
        this.addCommand({
            id: 'convert-selection-to-location',
            name: 'Convert Selection to Geolocation',
            editorCheckCallback: (checking, editor, view) => {
                if (checking) return editor.getSelection().length > 0;
                this.suggestor.selectionToLink(editor);
            },
        });

        // Command that adds a blank inline location at the cursor location
        this.addCommand({
            id: 'insert-geolink',
            name: 'Add inline geolocation link',
            editorCallback: (editor, view) => {
                const positionBeforeInsert = editor.getCursor();
                editor.replaceSelection('[](geo:)');
                editor.setCursor({
                    line: positionBeforeInsert.line,
                    ch: positionBeforeInsert.ch + 1,
                });
            },
        });

        // Command that opens the location search dialog and creates a new note from this location
        this.addCommand({
            id: 'new-geolocation-note',
            name: 'New geolocation note',
            callback: () => {
                const dialog = new NewNoteDialog(this.app, this.settings);
                dialog.open();
            },
        });

        // Command that opens the location search dialog and adds the location to the current note
        this.addCommand({
            id: 'add-frontmatter-geolocation',
            name: 'Add geolocation (front matter) to current note',
            editorCallback: (editor, view) => {
                const dialog = new NewNoteDialog(
                    this.app,
                    this.settings,
                    'addToNote',
                    editor
                );
                dialog.open();
            },
        });

        this.addSettingTab(new SettingsTab(this.app, this));

        // Add items to the file context menu (run when the context menu is built)
        // This is the context menu in the File Explorer and clicking "More options" (three dots) from within a file.
        this.app.workspace.on(
            'file-menu',
            (
                menu: Menu,
                file: TAbstractFile,
                _source: string,
                leaf?: WorkspaceLeaf
            ) => {
                if (file instanceof TFile) {
                    const location = getFrontMatterLocation(file, this.app);
                    if (location) {
                        // If there is a geolocation in the front matter of the file
                        // Add an option to open it in the map
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Show on map');
                            item.setIcon('globe');
                            item.onClick(
                                async (evt: MouseEvent) =>
                                    await this.openMapWithLocation(
                                        location,
                                        evt.ctrlKey
                                    )
                            );
                        });
                        // Add an option to open it in the default app
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Open with default app');
                            item.onClick((_ev) => {
                                open(`geo:${location.lat},${location.lng}`);
                            });
                        });
                        // Populate menu items from user defined "Open In" strings
                        utils.populateOpenInItems(
                            menu,
                            location,
                            this.settings
                        );
                    } else {
                        if (leaf && leaf.view instanceof MarkdownView) {
                            // If there is no valid geolocation in the front matter, add a menu item to populate it.
                            const editor = leaf.view.editor;
                            menu.addItem((item: MenuItem) => {
                                item.setTitle('Add geolocation (front matter)');
                                item.setIcon('globe');
                                item.onClick(async (evt: MouseEvent) => {
                                    const dialog = new NewNoteDialog(
                                        this.app,
                                        this.settings,
                                        'addToNote',
                                        editor
                                    );
                                    dialog.open();
                                });
                            });
                        }
                    }
                }
            }
        );

        // Add items to the editor context menu (run when the context menu is built)
        // This is the context menu when right clicking within an editor view.
        this.app.workspace.on(
            'editor-menu',
            async (menu: Menu, editor: Editor, view: MarkdownView) => {
                if (view instanceof FileView) {
                    const location = this.getLocationOnEditorLine(editor, view);
                    if (location) {
                        // If there is a geolocation on the line
                        // Add an option to open it in the map
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Show on map');
                            item.setIcon('globe');
                            item.onClick(
                                async (evt: MouseEvent) =>
                                    await this.openMapWithLocation(
                                        location,
                                        evt.ctrlKey
                                    )
                            );
                        });
                        // Add an option to open it in the default app
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Open with default app');
                            item.onClick((_ev) => {
                                open(`geo:${location.lat},${location.lng}`);
                            });
                        });
                        // Populate menu items from user defined "Open In" strings
                        utils.populateOpenInItems(
                            menu,
                            location,
                            this.settings
                        );
                    }
                    if (editor.getSelection()) {
                        // If there is text selected, add a menu item to convert it to coordinates using geosearch
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Convert to geolocation (geosearch)');
                            item.onClick(
                                async () =>
                                    await this.suggestor.selectionToLink(editor)
                            );
                        });
                    }

                    if (this.urlConvertor.findMatchInLine(editor))
                        // If the line contains a recognized geolocation that can be converted from a URL parsing rule
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Convert to geolocation');
                            item.onClick(async () => {
                                this.urlConvertor.convertUrlAtCursorToGeolocation(
                                    editor
                                );
                            });
                        });

                    const clipboard = await navigator.clipboard.readText();
                    const clipboardLocation =
                        this.urlConvertor.parseLocationFromUrl(
                            clipboard
                        )?.location;
                    if (clipboardLocation) {
                        // If the clipboard contains a recognized geolocation that can be converted from a URL parsing rule
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Paste as geolocation');
                            item.onClick(async () => {
                                this.urlConvertor.insertLocationToEditor(
                                    clipboardLocation,
                                    editor
                                );
                            });
                        });
                    }
                }
            }
        );
    }

    /**
     * Open an instance of the map at the given geolocation
     * @param location The geolocation to open the map at
     * @param ctrlKey Was the control key pressed
     */
    private async openMapWithLocation(
        location: leaflet.LatLng,
        ctrlKey: boolean
    ) {
        await this.openMapWithState(
            {
                mapCenter: location,
                mapZoom: this.settings.zoomOnGoFromNote,
            } as MapState,
            ctrlKey
        );
    }

    private async openMapWithState(state: MapState, ctrlKey: boolean) {
        // Find the best candidate for a leaf to open the map view on.
        // If there's an open map view, use that, otherwise use the current leaf.
        // If Ctrl is pressed, override that behavior and always use the current leaf.
        const maps = this.app.workspace.getLeavesOfType(consts.MAP_VIEW_NAME);
        let chosenLeaf: WorkspaceLeaf = null;
        if (maps && !ctrlKey) chosenLeaf = maps[0];
        else chosenLeaf = this.app.workspace.getLeaf();
        if (!chosenLeaf) chosenLeaf = this.app.workspace.activeLeaf;
        await chosenLeaf.setViewState({
            type: consts.MAP_VIEW_NAME,
            state: state,
        });
    }

    /**
     * Get the geolocation on the current editor line
     * @param editor obsidian Editor instance
     * @param view obsidian FileView instance
     * @private
     */
    private getLocationOnEditorLine(
        editor: Editor,
        view: FileView
    ): leaflet.LatLng {
        const line = editor.getLine(editor.getCursor().line);
        const match = matchInlineLocation(line)[0];
        let selectedLocation = null;
        if (match)
            selectedLocation = new leaflet.LatLng(
                parseFloat(match.groups.lat),
                parseFloat(match.groups.long)
            );
        else {
            const fmLocation = getFrontMatterLocation(view.file, this.app);
            if (line.indexOf('location') > -1 && fmLocation)
                selectedLocation = fmLocation;
        }
        if (selectedLocation) {
            verifyLocation(selectedLocation);
            return selectedLocation;
        }
        return null;
    }

    onunload() {}

    /** Initialise the plugin settings from Obsidian's cache */
    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    /** Save the plugin settings to Obsidian's cache so it can be reused later. */
    async saveSettings() {
        await this.saveData(this.settings);
    }
}
