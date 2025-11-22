import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';

export default new AutoloadPage('repo_study', async () => {
    // 从UiContext获取数据
    const units = UiContext.studyUnits || [];
    if (!units || units.length === 0) {
        return;
    }
    let currentUnitIndex = -1;
    let currentCardIndex = 0;
    let isFlipped = false;

    const unitListEl = $('#unit-list');
    const studyInterfaceEl = $('#study-interface');
    const currentUnitTitleEl = $('#current-unit-title');
    const currentCardIndexEl = $('#current-card-index');
    const totalCardsEl = $('#total-cards');
    const cardContainerEl = $('#card-container');
    const unitCompleteEl = $('#unit-complete');
    const cardTitleEl = $('#card-title');
    const cardContentEl = $('#card-content');
    const studyCardEl = $('#study-card');
    const passButtonEl = $('#pass-button');
    const exitStudyButtonEl = $('#exit-study');
    const nextUnitButtonEl = $('#next-unit-button');
    const backToListButtonEl = $('#back-to-list-button');

    // 从DOM中提取预渲染的HTML内容
    function extractUnitsFromDOM() {
        const extractedUnits = [];
        $('.unit-card').each(function() {
            const $card = $(this);
            const did = parseInt($card.data('did'));
            const unitIndex = parseInt($card.data('unit-index'));
            const docTitle = $card.find('div:first').text().trim();
            
            const blocks = [];
            $card.find('.block-data').each(function() {
                const $block = $(this);
                blocks.push({
                    bid: parseInt($block.data('bid')),
                    title: $block.data('title') || '',
                    contentHtml: $block.data('content-html') || '',
                });
            });
            
            if (blocks.length > 0) {
                extractedUnits.push({
                    did,
                    docTitle,
                    blocks,
                });
            }
        });
        return extractedUnits;
    }

    // 使用DOM中的数据（包含预渲染的HTML）
    const extractedUnits = extractUnitsFromDOM();
    if (extractedUnits.length > 0) {
        // 使用DOM中的数据，因为它包含预渲染的HTML
        units.splice(0, units.length, ...extractedUnits);
    }

    // 初始化单元列表点击事件
    $('.unit-card').on('click', function() {
        const unitIndex = parseInt($(this).data('unit-index'));
        if (unitIndex >= 0 && unitIndex < units.length) {
            startUnit(unitIndex);
        }
    });

    // 开始学习单元
    function startUnit(unitIndex) {
        currentUnitIndex = unitIndex;
        currentCardIndex = 0;
        isFlipped = false;
        
        const unit = units[unitIndex];
        currentUnitTitleEl.text(unit.docTitle);
        totalCardsEl.text(unit.blocks.length);
        
        unitListEl.hide();
        studyInterfaceEl.show();
        unitCompleteEl.hide();
        cardContainerEl.show();
        
        showCard();
    }

    // 从HTML内容中提取图片URL
    function extractImageUrls(html) {
        if (!html) return [];
        const urls = [];
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
            const src = img.src || img.getAttribute('src');
            if (src) {
                urls.push(src);
            }
        });
        return urls;
    }

    // 预加载图片
    function preloadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = () => reject(url);
            img.src = url;
        });
    }

    // 预加载后续卡片的图片（后台加载，不阻塞）
    function preloadNextCardsImages(count = 10) {
        const imageUrls = [];
        let unitIdx = currentUnitIndex;
        let cardIdx = currentCardIndex + 1;
        let loaded = 0;

        // 收集后续卡片的图片URL
        while (loaded < count && unitIdx < units.length) {
            const unit = units[unitIdx];
            if (cardIdx >= unit.blocks.length) {
                // 当前单元结束，跳到下一个单元
                unitIdx++;
                cardIdx = 0;
                continue;
            }

            const block = unit.blocks[cardIdx];
            if (block.contentHtml) {
                const urls = extractImageUrls(block.contentHtml);
                imageUrls.push(...urls);
            }

            cardIdx++;
            loaded++;
        }

        // 后台预加载图片（不阻塞UI）
        if (imageUrls.length > 0) {
            // 使用setTimeout让预加载在下一个事件循环执行，不阻塞当前渲染
            setTimeout(() => {
                imageUrls.forEach(url => {
                    preloadImage(url).catch(() => {
                        // 静默失败，不影响用户体验
                    });
                });
            }, 100);
        }
    }

    // 显示当前卡片
    function showCard() {
        if (currentUnitIndex < 0 || currentUnitIndex >= units.length) {
            return;
        }

        const unit = units[currentUnitIndex];
        if (currentCardIndex >= unit.blocks.length) {
            // 单元完成
            showUnitComplete();
            return;
        }

        const block = unit.blocks[currentCardIndex];
        cardTitleEl.text(block.title || '');
        
        // 使用模板预渲染的HTML内容
        if (block.contentHtml) {
            cardContentEl.html(block.contentHtml);
        } else {
            cardContentEl.html('');
        }
        
        // 重置卡片状态
        isFlipped = false;
        studyCardEl.removeClass('flipped');
        $('#card-front').show();
        $('#card-back').hide();
        
        currentCardIndexEl.text(currentCardIndex + 1);
        passButtonEl.prop('disabled', false);

        // 后台预加载后续10个卡片的图片
        preloadNextCardsImages(10);
    }

    // 翻转卡片
    function flipCard() {
        isFlipped = !isFlipped;
        if (isFlipped) {
            studyCardEl.addClass('flipped');
            $('#card-front').hide();
            $('#card-back').show();
        } else {
            studyCardEl.removeClass('flipped');
            $('#card-front').show();
            $('#card-back').hide();
        }
    }

    // 显示单元完成提示
    function showUnitComplete() {
        cardContainerEl.hide();
        unitCompleteEl.show();
        
        // 检查是否还有下一个单元
        const hasNextUnit = currentUnitIndex + 1 < units.length;
        if (hasNextUnit) {
            nextUnitButtonEl.show();
        } else {
            nextUnitButtonEl.hide();
        }
    }

    // 点击卡片翻转
    studyCardEl.on('click', function(e) {
        // 如果点击的是按钮，不翻转
        if ($(e.target).closest('button').length > 0) {
            return;
        }
        flipCard();
    });

    // Pass按钮 - 下一个卡片
    passButtonEl.on('click', function() {
        if (currentUnitIndex < 0 || currentUnitIndex >= units.length) {
            return;
        }

        const unit = units[currentUnitIndex];
        currentCardIndex++;
        
        if (currentCardIndex >= unit.blocks.length) {
            // 单元完成
            showUnitComplete();
        } else {
            showCard();
        }
    });

    // 退出学习
    exitStudyButtonEl.on('click', function() {
        unitListEl.show();
        studyInterfaceEl.hide();
        currentUnitIndex = -1;
        currentCardIndex = 0;
    });

    // 下一个单元
    nextUnitButtonEl.on('click', function() {
        if (currentUnitIndex + 1 < units.length) {
            startUnit(currentUnitIndex + 1);
        }
    });

    // 返回单元列表
    backToListButtonEl.on('click', function() {
        unitListEl.show();
        studyInterfaceEl.hide();
        currentUnitIndex = -1;
        currentCardIndex = 0;
    });
});

