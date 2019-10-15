import {
    AfterContentChecked, DoCheck, Input, Output, ViewChild,
    Component, ElementRef, EventEmitter, forwardRef, HostListener, IterableDiffer, IterableDiffers, ChangeDetectorRef, ContentChild,
    TemplateRef, Optional, Inject, InjectionToken, ChangeDetectionStrategy, HostBinding, Self
} from '@angular/core';

import { MatFormFieldControl, ErrorStateMatcher } from '@angular/material';
import { coerceBooleanProperty } from '@angular/cdk/coercion';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormControl, FormGroupDirective, NgForm, NgControl } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Observable, Subject, BehaviorSubject, EMPTY, of, from, merge, combineLatest } from 'rxjs';
import { tap, filter, map, share, flatMap, toArray, distinctUntilChanged } from 'rxjs/operators';
import * as lodashNs from 'lodash';
import * as escapeStringNs from 'escape-string-regexp';
import { NgxSelectOptGroup, NgxSelectOption, TSelectOption } from './ngx-select.classes';
import { NgxSelectOptionDirective, NgxSelectOptionNotFoundDirective, NgxSelectOptionSelectedDirective } from './ngx-templates.directive';
import { INgxOptionNavigated, INgxSelectOption, INgxSelectOptions } from './ngx-select.interfaces';

const _ = lodashNs;
const escapeString = escapeStringNs;

export const NGX_SELECT_OPTIONS = new InjectionToken<any>('NGX_SELECT_OPTIONS');

export interface INgxSelectComponentMouseEvent extends MouseEvent {
    clickedSelectComponent?: NgxSelectComponent;
}

enum ENavigation {
    first, previous, next, last,
    firstSelected, firstIfOptionActiveInvisible
}

function propertyExists(obj: Object, propertyName: string) {
    return propertyName in obj;
}
function anyPropertyExists(obj: Object, propertiesStr: string) {
    return propertiesStr.split('|').some(s => s.trim() in obj);
    // return propertyName in obj;
}

function getFirstProperty(obj: Object, propertiesStr: string) {
    return propertiesStr.split('|').map(s => s.trim()).find(s => s in obj);
    // return propertyName in obj;
}


export class NgSelectErrorStateMatcher {
    constructor(private ngSelect: NgxSelectComponent) {
    }
    isErrorState(control: FormControl | null, form: FormGroupDirective | NgForm | null): boolean {
        if (!control) {
            return this.ngSelect.required && this.ngSelect.empty;
        } else {
            return !!(control && control.invalid && (control.touched || (form && form.submitted)));
        }
    }
}

@Component({
    selector: 'ngx-select',
    templateUrl: './ngx-select.component.html',
    styleUrls: ['./ngx-select.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    providers: [
        {
            provide: MatFormFieldControl,
            useExisting: NgxSelectComponent
        }
    ]
})
export class NgxSelectComponent implements INgxSelectOptions, ControlValueAccessor, DoCheck, AfterContentChecked, MatFormFieldControl<any> {
    static nextId = 0;
    // @HostBinding() @Input() 
    id = `ngx-select-${NgxSelectComponent.nextId++}`;
    // @HostBinding('attr.aria-describedby')
    describedBy = '';
    // @Input() public ngControl: NgControl;
    // ngControl = null;
    errorState = false;
    stateChanges = new Subject<void>();
    focused = false;
    private _required = false;
    controlType = 'ngx-select';

    @Input() public items: any[];
    @Input() public optionValueField = 'id';
    @Input() public optionTextField = 'text';
    @Input() public optGroupLabelField = 'label';
    @Input() public optGroupOptionsField = 'options';
    @Input() public multiple = false;
    @Input() public allowClear = false;
    @Input() public placeholder = '';
    @Input() public noAutoComplete = false;
    @Input() public disabled = false;
    @Input() public defaultValue: any[] = [];
    @Input() public autoSelectSingleOption = false;
    @Input() public autoClearSearch = false;
    @Input() public noResultsFound = 'No results found';
    @Input() public keepSelectedItems: false;
    @Input() public size: 'small' | 'default' | 'large' = 'default';
    @Input() public searchCallback: (search: string, item: INgxSelectOption) => boolean;
    @Input() public autoActiveOnMouseEnter = true;
    @Input() public isFocused = false;
    public keyCodeToRemoveSelected = 'Delete';
    public keyCodeToOptionsOpen = ['Enter', 'NumpadEnter'];
    public keyCodeToOptionsClose = 'Escape';
    public keyCodeToOptionsSelect = ['Enter', 'NumpadEnter'];
    public keyCodeToNavigateFirst = 'ArrowLeft';
    public keyCodeToNavigatePrevious = 'ArrowUp';
    public keyCodeToNavigateNext = 'ArrowDown';
    public keyCodeToNavigateLast = 'ArrowRight';

    @Output() public typed = new EventEmitter<string>();
    @Output() public focus = new EventEmitter<void>();
    @Output() public blur = new EventEmitter<void>();
    @Output() public open = new EventEmitter<void>();
    @Output() public close = new EventEmitter<void>();
    @Output() public select = new EventEmitter<any>();
    @Output() public remove = new EventEmitter<any>();
    @Output() public navigated = new EventEmitter<INgxOptionNavigated>();
    @Output() public selectionChanges = new EventEmitter<INgxSelectOption[]>();

    @ViewChild('main') protected mainElRef: ElementRef;
    @ViewChild('input') protected inputElRef: ElementRef;
    @ViewChild('choiceMenu') protected choiceMenuElRef: ElementRef;

    @ContentChild(NgxSelectOptionDirective, { read: TemplateRef }) templateOption: NgxSelectOptionDirective;
    @ContentChild(NgxSelectOptionSelectedDirective, { read: TemplateRef }) templateSelectedOption: NgxSelectOptionSelectedDirective;
    @ContentChild(NgxSelectOptionNotFoundDirective, { read: TemplateRef }) templateOptionNotFound: NgxSelectOptionNotFoundDirective;

    public optionsOpened = false;
    public optionsFiltered: TSelectOption[];

    private optionActive: NgxSelectOption;
    private itemsDiffer: IterableDiffer<any>;
    private defaultValueDiffer: IterableDiffer<any[]>;
    private actualValue: any[] = [];

    public subjOptions = new BehaviorSubject<TSelectOption[]>([]);
    private subjSearchText = new BehaviorSubject<string>('');

    private subjOptionsSelected = new BehaviorSubject<NgxSelectOption[]>([]);
    private subjExternalValue = new BehaviorSubject<any[]>([]);
    private subjDefaultValue = new BehaviorSubject<any[]>([]);
    private subjRegisterOnChange = new Subject();

    private cacheOptionsFilteredFlat: NgxSelectOption[];
    private cacheElementOffsetTop: number;

    private _focusToInput = false;


    /** @internal */
    public get inputText() {
        if (this.inputElRef && this.inputElRef.nativeElement) {
            return this.inputElRef.nativeElement.value;
        }
        return '';
    }

    constructor(iterableDiffers: IterableDiffers, private sanitizer: DomSanitizer, private cd: ChangeDetectorRef,
        @Inject(NGX_SELECT_OPTIONS) @Optional() defaultOptions: INgxSelectOptions,
        @Optional() private _parentForm: NgForm,
        @Optional() private _parentFormGroup: FormGroupDirective,
        @Optional() @Self() public ngControl: NgControl) {

        // console.log('Contructing ngx-select-comp');

        if (this.ngControl != null) {
            // Setting the value accessor directly (instead of using
            // the providers) to avoid running into a circular import.
            this.ngControl.valueAccessor = this;
        }

        Object.assign(this, defaultOptions);

        // DIFFERS
        this.itemsDiffer = iterableDiffers.find([]).create<any>(null);
        this.defaultValueDiffer = iterableDiffers.find([]).create<any>(null);

        // OBSERVERS
        this.typed.subscribe((text: string) => this.subjSearchText.next(text));
        this.subjOptionsSelected.subscribe((options: NgxSelectOption[]) => this.selectionChanges.emit(options));
        let cacheExternalValue: any[];

        // Get actual value
        const subjActualValue = combineLatest(
            merge(
                this.subjExternalValue.pipe(map(
                    (v: any[]) => cacheExternalValue = v === null ? [] : [].concat(v)
                )),
                this.subjOptionsSelected.pipe(map(
                    (options: NgxSelectOption[]) => options.map((o: NgxSelectOption) => o.data)
                ))
            ),
            this.subjDefaultValue
        ).pipe(
            map(([eVal, dVal]: [any[], any[]]) => {
                const newVal = _.isEqual(eVal, dVal) ? [] : eVal;
                return newVal.length ? newVal : dVal;
            }),
            distinctUntilChanged((x, y) => _.isEqual(x, y)),
            share()
        );

        // Export actual value
        combineLatest(subjActualValue, this.subjRegisterOnChange)
            .pipe(map(([actualValue]: [any[], any[]]) => actualValue))
            .subscribe((actualValue: any[]) => {
                this.actualValue = actualValue;
                if (!_.isEqual(actualValue, cacheExternalValue)) {
                    cacheExternalValue = actualValue;
                    if (this.multiple) {
                        this.onChange(actualValue);
                    } else {
                        this.onChange(actualValue.length ? actualValue[0] : null);
                    }
                }
            });

        // Correct selected options when the options changed
        combineLatest(
            this.subjOptions.pipe(
                flatMap((options: TSelectOption[]) => from(options).pipe(
                    flatMap((option: TSelectOption) => option instanceof NgxSelectOption
                        ? of(option)
                        : (option instanceof NgxSelectOptGroup ? from(option.options) : EMPTY)
                    ),
                    toArray()
                ))
            ),
            subjActualValue
        ).pipe(
            map(([optionsFlat, actualValue]: [NgxSelectOption[], any[]]) => {
                const optionsSelected = [];

                actualValue.forEach((value: any) => {
                    const selectedOption = optionsFlat.find((option: NgxSelectOption) =>
                        value && (value[this.optionValueField] ? option.value === value[this.optionValueField] : option.value === value));
                    if (selectedOption) {
                        optionsSelected.push(selectedOption);
                    }
                });

                if (this.keepSelectedItems) {
                    const optionValues = optionsSelected.map((option: NgxSelectOption) => option.value);
                    const keptSelectedOptions = this.subjOptionsSelected.value
                        .filter((selOption: NgxSelectOption) => optionValues.indexOf(selOption.value) === -1);
                    optionsSelected.push(...keptSelectedOptions);
                }

                if (!_.isEqual(optionsSelected, this.subjOptionsSelected.value)) {
                    this.subjOptionsSelected.next(optionsSelected);
                    this.cd.markForCheck();
                }

            })
        ).subscribe();

        // Ensure working filter by a search text
        combineLatest(this.subjOptions, this.subjOptionsSelected, this.subjSearchText).pipe(
            map(([options, selectedOptions, search]: [TSelectOption[], NgxSelectOption[], string]) => {
                this.optionsFiltered = this.filterOptions(search, options, selectedOptions).map(option => {
                    if (option instanceof NgxSelectOption) {
                        option.highlightedText = this.highlightOption(option);
                    } else if (option instanceof NgxSelectOptGroup) {
                        option.options.map(subOption => {
                            subOption.highlightedText = this.highlightOption(subOption);
                            return subOption;
                        });
                    }
                    return option;
                });
                this.cacheOptionsFilteredFlat = null;
                this.navigateOption(ENavigation.firstIfOptionActiveInvisible);
                this.cd.markForCheck();
                return selectedOptions;
            }),
            flatMap((selectedOptions: NgxSelectOption[]) => this.optionsFilteredFlat().pipe(filter(
                (flatOptions: NgxSelectOption[]) => this.autoSelectSingleOption && flatOptions.length === 1 && !selectedOptions.length
            )))
        ).subscribe((flatOptions: NgxSelectOption[]) => {
            this.subjOptionsSelected.next(flatOptions);
            this.cd.markForCheck();
        });
        // console.log('contructor of ngx-select is complete');
    }

    @Input() errorStateMatcher: ErrorStateMatcher;
    private _defaultErrorStateMatcher: ErrorStateMatcher = new NgSelectErrorStateMatcher(this);

    setDescribedByIds(ids: string[]): void {
        this.describedBy = ids.join(' ');
    }

    onContainerClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        if (target.classList.contains('mat-form-field-infix')) {
            this.focus.emit();
            this.open.emit();
        }
    }

    @HostBinding('class.floating')
    get shouldLabelFloat() {
        // console.log('showlabelFloat::: ' + (this.isFocused || !this.empty));
        return !this.empty;
    }

    get empty(): boolean {
        // console.log('In empty():: this.subjOptionsSelected.value =' +
        //     this.subjOptionsSelected.value + ' stringified=' + JSON.stringify(this.subjOptionsSelected.value) + ' actualValue= '
        //     + JSON.stringify(this.actualValue));
        return this.subjOptionsSelected.value && this.subjOptionsSelected.value.length === 0;
    }

    @Input()
    get required(): boolean { return this._required; }
    set required(value: boolean) {
        this._required = coerceBooleanProperty(value);
        this.stateChanges.next();
    }


    public setFormControlSize(otherClassNames: Object = {}, useFormControl: boolean = true) {
        const formControlExtraClasses = useFormControl ? {
            'form-control-sm input-sm': this.size === 'small',
            'form-control-lg input-lg': this.size === 'large'
        } : {};
        return Object.assign(formControlExtraClasses, otherClassNames);
    }

    public setBtnSize() {
        return { 'btn-sm': this.size === 'small', 'btn-lg': this.size === 'large' };
    }

    public get optionsSelected(): NgxSelectOption[] {
        return this.subjOptionsSelected.value;
    }

    public mainClicked(event: INgxSelectComponentMouseEvent) {
        // console.log('In mainClicked() of custom ngx-select');
        const ele = event.target as HTMLElement; let flag = false;
        if (ele.className.includes('ngx-select__toggle') || ele.offsetParent.className.includes('ngx-select__toggle')) {
            flag = true;
            event.clickedSelectComponent = !this.optionsOpened ? this : undefined;
        } else {
            event.clickedSelectComponent = this;
        }
        if (!this.isFocused) {
            this.isFocused = true;
            this.focus.emit();
        }
        if (this.optionsOpened && flag) {
            this.optionsClose();
            this.cd.detectChanges(); // fix error because of delay between different events
        } else {
            this.optionsOpen();
        }
    }

    // @HostListener('document:focusin', ['$event'])
    @HostListener('document:click', ['$event'])
    public documentClick(event: INgxSelectComponentMouseEvent) {
        if (event.clickedSelectComponent !== this) {
            if (this.optionsOpened) {
                this.optionsClose();
                this.cd.detectChanges(); // fix error because of delay between different events
            }
            if (this.isFocused) {
                this.isFocused = false;
                this.blur.emit();
            }
        }
    }

    private optionsFilteredFlat(): Observable<NgxSelectOption[]> {
        if (this.cacheOptionsFilteredFlat) {
            return of(this.cacheOptionsFilteredFlat);
        }

        return from(this.optionsFiltered).pipe(
            flatMap<TSelectOption, any>((option: TSelectOption) =>
                option instanceof NgxSelectOption ? of(option) :
                    (option instanceof NgxSelectOptGroup ? from(option.optionsFiltered) : EMPTY)
            ),
            filter((optionsFilteredFlat: NgxSelectOption) => !optionsFilteredFlat.disabled),
            toArray(),
            tap((optionsFilteredFlat: NgxSelectOption[]) => this.cacheOptionsFilteredFlat = optionsFilteredFlat)
        );
    }

    private navigateOption(navigation: ENavigation) {
        this.optionsFilteredFlat().pipe(
            map<NgxSelectOption[], INgxOptionNavigated>((options: NgxSelectOption[]) => {
                const navigated: INgxOptionNavigated = { index: -1, activeOption: null, filteredOptionList: options };
                let newActiveIdx;
                switch (navigation) {
                    case ENavigation.first:
                        navigated.index = 0;
                        break;
                    case ENavigation.previous:
                        newActiveIdx = options.indexOf(this.optionActive) - 1;
                        navigated.index = newActiveIdx >= 0 ? newActiveIdx : options.length - 1;
                        break;
                    case ENavigation.next:
                        newActiveIdx = options.indexOf(this.optionActive) + 1;
                        navigated.index = newActiveIdx < options.length ? newActiveIdx : 0;
                        break;
                    case ENavigation.last:
                        navigated.index = options.length - 1;
                        break;
                    case ENavigation.firstSelected:
                        if (this.subjOptionsSelected.value.length) {
                            navigated.index = options.indexOf(this.subjOptionsSelected.value[0]);
                        }
                        break;
                    case ENavigation.firstIfOptionActiveInvisible:
                        let idxOfOptionActive = -1;
                        if (this.optionActive) {
                            idxOfOptionActive = options.indexOf(options.find(x => x.value === this.optionActive.value));
                        }
                        navigated.index = idxOfOptionActive > 0 ? idxOfOptionActive : 0;
                        break;
                }
                navigated.activeOption = options[navigated.index];
                return navigated;
            })
        ).subscribe((newNavigated: INgxOptionNavigated) => this.optionActivate(newNavigated));
    }

    public ngDoCheck(): void {
        if (this.itemsDiffer.diff(this.items)) {
            this.subjOptions.next(this.buildOptions(this.items));
        }

        const defVal = this.defaultValue ? [].concat(this.defaultValue) : [];
        if (this.defaultValueDiffer.diff(defVal)) {
            this.subjDefaultValue.next(defVal);
        }
        this.updateErrorState();
    }

    updateErrorState() {
        const oldState = this.errorState;
        const parent = this._parentFormGroup || this._parentForm;
        const matcher = this.errorStateMatcher || this._defaultErrorStateMatcher;
        const control = this.ngControl ? this.ngControl.control as FormControl : null;
        const newState = matcher.isErrorState(control, parent);

        if (newState !== oldState) {
            this.errorState = newState;
            this.stateChanges.next();
        }
    }

    public ngAfterContentChecked(): void {
        if (this._focusToInput && this.checkInputVisibility() && this.inputElRef &&
            this.inputElRef.nativeElement !== document.activeElement) {
            this._focusToInput = false;
            this.inputElRef.nativeElement.focus();
        }

        if (this.choiceMenuElRef) {
            const ulElement = this.choiceMenuElRef.nativeElement as HTMLUListElement;
            const element = ulElement.querySelector('a.ngx-select__item_active.active') as HTMLLinkElement;

            if (element && element.offsetHeight > 0) {
                this.ensureVisibleElement(element);
            }

        }
    }

    public canClearNotMultiple(): boolean {
        return this.allowClear && !!this.subjOptionsSelected.value.length &&
            (!this.subjDefaultValue.value.length || this.subjDefaultValue.value[0] !== this.actualValue[0]);
    }

    public focusToInput(): void {
        this._focusToInput = true;
    }

    public inputKeyDown(event: KeyboardEvent) {
        const keysForOpenedState = [].concat(
            this.keyCodeToOptionsSelect,
            this.keyCodeToNavigateFirst,
            this.keyCodeToNavigatePrevious,
            this.keyCodeToNavigateNext,
            this.keyCodeToNavigateLast
        );
        const keysForClosedState = [].concat(this.keyCodeToOptionsOpen, this.keyCodeToRemoveSelected);

        if (this.optionsOpened && keysForOpenedState.indexOf(event.code) !== -1) {
            event.preventDefault();
            event.stopPropagation();
            switch (event.code) {
                case ([].concat(this.keyCodeToOptionsSelect).indexOf(event.code) + 1) && event.code:
                    this.optionSelect(this.optionActive);
                    this.navigateOption(ENavigation.next);
                    break;
                case this.keyCodeToNavigateFirst:
                    this.navigateOption(ENavigation.first);
                    break;
                case this.keyCodeToNavigatePrevious:
                    this.navigateOption(ENavigation.previous);
                    break;
                case this.keyCodeToNavigateLast:
                    this.navigateOption(ENavigation.last);
                    break;
                case this.keyCodeToNavigateNext:
                    this.navigateOption(ENavigation.next);
                    break;
            }
        } else if (!this.optionsOpened && keysForClosedState.indexOf(event.code) !== -1) {
            event.preventDefault();
            event.stopPropagation();
            switch (event.code) {
                case ([].concat(this.keyCodeToOptionsOpen).indexOf(event.code) + 1) && event.code:
                    this.optionsOpen();
                    break;
                case this.keyCodeToRemoveSelected:
                    this.optionRemove(this.subjOptionsSelected.value[this.subjOptionsSelected.value.length - 1], event);
                    break;
            }
        }
    }

    public trackByOption(index: number, option: TSelectOption) {
        return option instanceof NgxSelectOption ? option.value :
            (option instanceof NgxSelectOptGroup ? option.label : option);
    }

    public checkInputVisibility(): boolean {
        return (this.multiple === true) || (this.optionsOpened && !this.noAutoComplete);
    }

    /** @internal */
    public inputKeyUp(value: string = '', event: KeyboardEvent) {
        if (event.code === this.keyCodeToOptionsClose) {
            this.optionsClose(/*true*/);
        } else if (this.optionsOpened && (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].indexOf(event.code) === -1)/*ignore arrows*/) {
            this.typed.emit(value);
        } else if (!this.optionsOpened && value) {
            this.optionsOpen(value);
        }
    }

    /** @internal */
    public inputClick(value: string = '') {
        if (!this.optionsOpened) {
            this.optionsOpen(value);
        }
    }

    /** @internal */
    public sanitize(html: string): SafeHtml {
        return html ? this.sanitizer.bypassSecurityTrustHtml(html) : null;
    }

    /** @internal */
    public highlightOption(option: NgxSelectOption): SafeHtml {
        if (this.inputElRef) {
            return option.renderText(this.sanitizer, this.inputElRef.nativeElement.value);
        }
        return option.renderText(this.sanitizer, '');
    }

    /** @internal */
    public optionSelect(option: NgxSelectOption, event: Event = null): void {
        // console.log('Option selected in custom ngxselect');
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (option && !option.disabled) {
            this.subjOptionsSelected.next((this.multiple ? this.subjOptionsSelected.value : []).concat([option]));
            this.select.emit(option.value);
            this.optionsClose(/*true*/);
            this.onTouched();
        }
    }

    /** @internal */
    public optionRemove(option: NgxSelectOption, event: Event): void {
        if (!this.disabled && option) {
            event.stopPropagation();
            this.subjOptionsSelected.next((this.multiple ? this.subjOptionsSelected.value : []).filter(o => o !== option));
            this.remove.emit(option.value);
        }
    }

    /** @internal */
    public optionActivate(navigated: INgxOptionNavigated): void {
        if ((this.optionActive !== navigated.activeOption) &&
            (!navigated.activeOption || !navigated.activeOption.disabled)) {
            if (this.optionActive) {
                this.optionActive.active = false;
            }

            this.optionActive = navigated.activeOption;

            if (this.optionActive) {
                this.optionActive.active = true;
            }
            this.navigated.emit(navigated);
            this.cd.detectChanges();
        }
    }

    /** @internal */
    public onMouseEnter(navigated: INgxOptionNavigated): void {
        document.onmousemove = () => {
            if (this.autoActiveOnMouseEnter) {
                this.optionActivate(navigated);
            }
        };
    }

    private filterOptions(search: string, options: TSelectOption[], selectedOptions: NgxSelectOption[]): TSelectOption[] {
        const regExp = new RegExp(escapeString(search), 'i'),
            filterOption = (option: NgxSelectOption) => {
                if (this.searchCallback) {
                    return this.searchCallback(search, option);
                }
                return (!search || regExp.test(option.text)) && (!this.multiple || selectedOptions.indexOf(option) === -1);
            };

        return options.filter((option: TSelectOption) => {
            if (option instanceof NgxSelectOption) {
                return filterOption(<NgxSelectOption>option);
            } else if (option instanceof NgxSelectOptGroup) {
                const subOp = <NgxSelectOptGroup>option;
                subOp.filter((subOption: NgxSelectOption) => filterOption(subOption));
                return subOp.optionsFiltered.length;
            }
        });
    }

    private ensureVisibleElement(element: HTMLElement) {
        if (this.choiceMenuElRef && this.cacheElementOffsetTop !== element.offsetTop) {
            this.cacheElementOffsetTop = element.offsetTop;
            const container: HTMLElement = this.choiceMenuElRef.nativeElement;
            if (this.cacheElementOffsetTop < container.scrollTop) {
                container.scrollTop = this.cacheElementOffsetTop;
            } else if (this.cacheElementOffsetTop + element.offsetHeight > container.scrollTop + container.clientHeight) {
                container.scrollTop = this.cacheElementOffsetTop + element.offsetHeight - container.clientHeight;
            }
        }
    }

    public optionsOpen(search: string = '') {
        if (!this.disabled) {
            this.optionsOpened = true;
            this.subjSearchText.next(search);
            if (!this.multiple && this.subjOptionsSelected.value.length) {
                this.navigateOption(ENavigation.firstSelected);
            } else {
                this.navigateOption(ENavigation.first);
            }
            this.focusToInput();
            this.open.emit();
            this.cd.markForCheck();
        }
    }

    public optionsClose(/*focusToHost: boolean = false*/) {
        this.optionsOpened = false;
        // if (focusToHost) {
        //     const x = window.scrollX, y = window.scrollY;
        //     this.mainElRef.nativeElement.focus();
        //     window.scrollTo(x, y);
        // }
        this.close.emit();

        if (this.ngControl && this.ngControl.control) {
            this.ngControl.control.markAsTouched();
        }

        if (this.autoClearSearch && this.multiple && this.inputElRef) {
            this.inputElRef.nativeElement.value = null;
        }
    }

    private buildOptions(data: any[]): Array<NgxSelectOption | NgxSelectOptGroup> {
        const result: Array<NgxSelectOption | NgxSelectOptGroup> = [];
        if (Array.isArray(data)) {
            let option: NgxSelectOption;
            data.forEach((item: any) => {
                const isOptGroup = typeof item === 'object' && item !== null &&
                    propertyExists(item, this.optGroupLabelField) && propertyExists(item, this.optGroupOptionsField) &&
                    Array.isArray(item[this.optGroupOptionsField]);
                if (isOptGroup) {
                    const optGroup = new NgxSelectOptGroup(item[this.optGroupLabelField]);
                    item[this.optGroupOptionsField].forEach((subOption: NgxSelectOption) => {
                        if (option = this.buildOption(subOption, optGroup)) {
                            optGroup.options.push(option);
                        }
                    });
                    result.push(optGroup);
                } else if (option = this.buildOption(item, null)) {
                    result.push(option);
                }
            });
        }
        return result;
    }

    private buildOption(data: any, parent: NgxSelectOptGroup): NgxSelectOption {
        let value, text, disabled;
        if (typeof data === 'string' || typeof data === 'number') {
            value = text = data;
            disabled = false;
        } else if (typeof data === 'object' && data !== null &&
            (propertyExists(data, this.optionValueField) || propertyExists(data, this.optionTextField))) {
            value = propertyExists(data, this.optionValueField) ? data[this.optionValueField] : data[this.optionTextField];
            text = anyPropertyExists(data, this.optionTextField) ?
                data[getFirstProperty(data, this.optionTextField)] : data[this.optionValueField];
            disabled = propertyExists(data, 'disabled') ? data['disabled'] : false;
        } else {
            return null;
        }
        return new NgxSelectOption(value, text, disabled, data, parent);
    }

    //////////// interface ControlValueAccessor ////////////
    public onChange = (v: any) => v;

    public onTouched: () => void = () => null;

    public writeValue(obj: any): void {
        this.subjExternalValue.next(obj);
    }

    public registerOnChange(fn: (_: any) => {}): void {
        this.onChange = fn;
        this.subjRegisterOnChange.next();
    }

    public registerOnTouched(fn: () => {}): void {
        this.onTouched = fn;
    }

    public setDisabledState(isDisabled: boolean): void {
        this.disabled = isDisabled;
        this.cd.markForCheck();
    }

    @Input()
    get value(): any {
        // console.log('Returning value = ' + JSON.stringify(this.subjOptionsSelected.value));
        return this.subjOptionsSelected.value;
    }
    set value(v: any) {
        // console.log('writing value = ' + JSON.stringify(v));
        this.writeValue(v);

    }
    // private _value: any;

}
